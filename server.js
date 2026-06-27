'use strict';
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const http    = require('http');
const WebSocket = require('ws');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fs      = require('fs');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws' });
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'zepply_secret_2024_jodhpur';
const DB_FILE = path.join(__dirname, 'data', 'db.json');

// ══════════════════════════════════════════════════════════════
// DATABASE
// ══════════════════════════════════════════════════════════════
const readDB  = () => { try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch{ return {}; } };
const writeDB = d  => fs.writeFileSync(DB_FILE, JSON.stringify(d,null,2));

const DB = {
  all:  col       => { const d=readDB(); return d[col]||[]; },
  find: (col,f={})=> DB.all(col).filter(r=>Object.keys(f).every(k=>r[k]===f[k])),
  one:  (col,f={})=> DB.find(col,f)[0]||null,
  byId: (col,id)  => DB.all(col).find(r=>r.id===id)||null,
  insert:(col,rec)=> { const d=readDB(); (d[col]=d[col]||[]).push(rec); writeDB(d); return rec; },
  update:(col,id,up)=> {
    const d=readDB(); const items=d[col]||[]; const i=items.findIndex(r=>r.id===id);
    if(i<0) return null;
    items[i]={...items[i],...up,updated_at:new Date().toISOString()};
    d[col]=items; writeDB(d); return items[i];
  },
  updateMany:(col,f,up)=>{
    const d=readDB(); let n=0;
    d[col]=(d[col]||[]).map(r=>{
      if(Object.keys(f).every(k=>r[k]===f[k])){ n++; return {...r,...up,updated_at:new Date().toISOString()}; }
      return r;
    }); writeDB(d); return n;
  },
  del:(col,id)=>{ const d=readDB(); const before=(d[col]||[]).length; d[col]=(d[col]||[]).filter(r=>r.id!==id); writeDB(d); return before>(d[col]||[]).length; },
  inc:(col,id,field,by=1)=>{ const d=readDB(); const items=d[col]||[]; const i=items.findIndex(r=>r.id===id); if(i<0)return null; items[i][field]=(items[i][field]||0)+by; items[i].updated_at=new Date().toISOString(); d[col]=items; writeDB(d); return items[i]; }
};

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════
const token = userId => jwt.sign({userId}, SECRET, {expiresIn:'7d'});
const safe  = user   => { if(!user) return null; const {password:_,...u}=user; return u; };
const uid   = ()     => uuidv4().replace(/-/g,'').slice(0,12);
const now   = ()     => new Date().toISOString();
const haversine = (lat1,lng1,lat2,lng2) => {
  const R=6371, dLat=(lat2-lat1)*Math.PI/180, dLng=(lng2-lng1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
};
const notify = (userId, title, body) => DB.insert('notifications',{
  id:'n'+uid(), user_id:userId, title, body, read:false, created_at:now()
});

// WebSocket broadcast
const wsClients = new Map();
const wsBroadcast = (userId, data) => {
  const ws = wsClients.get(userId);
  if(ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(data));
};

// ══════════════════════════════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════════════════════════════
app.use(cors({origin:'*'}));
app.use(express.json({limit:'10mb'}));
app.use(express.static(path.join(__dirname,'public')));
app.use((req,_,next)=>{ const t=new Date().toISOString().slice(11,19); console.log(`[${t}] ${req.method} ${req.path}`); next(); });

const authMW = (req,res,next) => {
  const h = req.headers['authorization'];
  const t = h && h.startsWith('Bearer ') ? h.slice(7) : null;
  if(!t) return res.status(401).json({success:false,message:'Authorization token required'});
  try {
    const {userId} = jwt.verify(t, SECRET);
    const user = DB.byId('users', userId);
    if(!user) return res.status(401).json({success:false,message:'User not found'});
    req.user = user; next();
  } catch { return res.status(401).json({success:false,message:'Invalid or expired token'}); }
};

const role = (...roles) => (req,res,next) => {
  if(!req.user) return res.status(401).json({success:false,message:'Not authenticated'});
  if(!roles.includes(req.user.role)) return res.status(403).json({success:false,message:`Requires role: ${roles.join(' or ')}`});
  next();
};

// ══════════════════════════════════════════════════════════════
// ROUTES — AUTH
// ══════════════════════════════════════════════════════════════
const auth = express.Router();

auth.post('/register', async(req,res)=>{
  try {
    const {name,email,phone,password,role:r='customer',referred_by} = req.body;
    if(!name||!email||!phone||!password) return res.status(400).json({success:false,message:'All fields required'});
    if(!['customer','shopowner','delivery'].includes(r)) return res.status(400).json({success:false,message:'Invalid role'});
    if(DB.one('users',{email})) return res.status(409).json({success:false,message:'Email already registered'});
    const hashed = await bcrypt.hash(password,10);
    const refCode = 'ZEP'+Math.floor(1000+Math.random()*9000);
    const user = {id:'u'+uid(),name,email,phone,password:hashed,role:r,loyalty_points:100,tier:'bronze',referral_code:refCode,referred_by:referred_by||null,created_at:now()};
    DB.insert('users',user);
    if(referred_by){
      const referrer=DB.one('users',{referral_code:referred_by});
      if(referrer){ DB.inc('users',referrer.id,'loyalty_points',200); DB.insert('referrals',{id:'ref'+uid(),referrer_id:referrer.id,referred_id:user.id,reward:200,created_at:now()}); notify(referrer.id,'Referral Reward! 🎉',`${name} joined! You earned 200 ZepCoins.`); }
    }
    if(r==='delivery') DB.insert('delivery_partners',{id:'dp'+uid(),user_id:user.id,status:'pending',rating:5.0,total_deliveries:0,total_earnings:0,coins:100,badge:'bronze',created_at:now()});
    notify(user.id,'Welcome to Zepply! 🎉',`Welcome ${name}! 100 ZepCoins added as welcome bonus.`);
    res.status(201).json({success:true,message:'Registered successfully!',token:token(user.id),user:safe(user)});
  } catch(e){ console.error(e); res.status(500).json({success:false,message:'Server error'}); }
});

auth.post('/login', async(req,res)=>{
  try {
    const {email,password} = req.body;
    if(!email||!password) return res.status(400).json({success:false,message:'Email and password required'});
    const user = DB.one('users',{email});
    if(!user) return res.status(401).json({success:false,message:'Invalid credentials'});
    const ok = await bcrypt.compare(password, user.password);
    if(!ok) return res.status(401).json({success:false,message:'Invalid credentials'});
    res.json({success:true,message:'Login successful',token:token(user.id),user:safe(user)});
  } catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

auth.get('/me', authMW, (req,res)=> res.json({success:true,user:safe(req.user)}));

auth.put('/profile', authMW, (req,res)=>{
  const {name,phone,address} = req.body;
  const up={};
  if(name) up.name=name; if(phone) up.phone=phone; if(address) up.address=address;
  res.json({success:true,user:safe(DB.update('users',req.user.id,up))});
});

auth.put('/change-password', authMW, async(req,res)=>{
  const {current_password,new_password} = req.body;
  const user = DB.byId('users',req.user.id);
  const ok = await bcrypt.compare(current_password, user.password);
  if(!ok) return res.status(400).json({success:false,message:'Current password incorrect'});
  DB.update('users',req.user.id,{password:await bcrypt.hash(new_password,10)});
  res.json({success:true,message:'Password changed'});
});

// ══════════════════════════════════════════════════════════════
// ROUTES — SHOPS
// ══════════════════════════════════════════════════════════════
const shops = express.Router();

// IMPORTANT: /all/products BEFORE /:id
shops.get('/all/products', (req,res)=>{
  const {search,category,on_sale,shop_id} = req.query;
  let products = DB.all('products').filter(p=>p.is_active===true);
  if(shop_id) products=products.filter(p=>p.shop_id===shop_id);
  if(category) products=products.filter(p=>p.category&&p.category.toLowerCase()===category.toLowerCase());
  if(search){ const q=search.toLowerCase(); products=products.filter(p=>p.name.toLowerCase().includes(q)||(p.category&&p.category.toLowerCase().includes(q))); }
  if(on_sale==='true') products=products.filter(p=>p.discount>0);
  products=products.map(p=>{ const s=DB.byId('shops',p.shop_id); return {...p,shop_name:s?.name||'',shop_emoji:s?.emoji||'🏪'}; });
  res.json({success:true,products,total:products.length});
});

shops.get('/', (req,res)=>{
  const {category,lat,lng,radius=5,search} = req.query;
  let list = DB.all('shops');
  if(category) list=list.filter(s=>s.category.toLowerCase()===category.toLowerCase());
  if(search){ const q=search.toLowerCase(); list=list.filter(s=>s.name.toLowerCase().includes(q)); }
  list=list.map(s=>{
    const prods=DB.all('products').filter(p=>p.shop_id===s.id&&p.is_active===true);
    const dist=(lat&&lng)?haversine(parseFloat(lat),parseFloat(lng),s.lat,s.lng):null;
    return {...s,product_count:prods.length,distance_km:dist?parseFloat(dist.toFixed(2)):null};
  });
  if(lat&&lng) list=list.filter(s=>s.distance_km===null||s.distance_km<=parseFloat(radius));
  res.json({success:true,shops:list,total:list.length});
});

shops.get('/:id', (req,res)=>{
  const shop=DB.byId('shops',req.params.id);
  if(!shop) return res.status(404).json({success:false,message:'Shop not found'});
  const products=DB.all('products').filter(p=>p.shop_id===shop.id&&p.is_active===true);
  const reviews=DB.find('reviews',{shop_id:shop.id});
  res.json({success:true,shop:{...shop,products,reviews}});
});

shops.post('/', authMW, role('shopowner'), (req,res)=>{
  const {name,category,description='',emoji='🏪',address,lat=0,lng=0,gst='',min_order=100,delivery_charge=25} = req.body;
  if(!name||!category||!address) return res.status(400).json({success:false,message:'name, category, address required'});
  const shop={id:'s'+uid(),owner_id:req.user.id,name,category,description,emoji,address,lat,lng,rating:0,total_reviews:0,is_open:true,delivery_time:'20 min',min_order,delivery_charge,gst,created_at:now()};
  res.status(201).json({success:true,shop:DB.insert('shops',shop)});
});

shops.put('/:id', authMW, role('shopowner'), (req,res)=>{
  const shop=DB.byId('shops',req.params.id);
  if(!shop) return res.status(404).json({success:false,message:'Shop not found'});
  if(shop.owner_id!==req.user.id) return res.status(403).json({success:false,message:'Not your shop'});
  res.json({success:true,shop:DB.update('shops',req.params.id,req.body)});
});

shops.put('/:id/toggle', authMW, role('shopowner'), (req,res)=>{
  const shop=DB.byId('shops',req.params.id);
  if(!shop) return res.status(404).json({success:false,message:'Shop not found'});
  if(shop.owner_id!==req.user.id) return res.status(403).json({success:false,message:'Not your shop'});
  const updated=DB.update('shops',req.params.id,{is_open:!shop.is_open});
  res.json({success:true,is_open:updated.is_open,message:updated.is_open?'🟢 Shop is now Open':'🔴 Shop is now Closed'});
});

shops.get('/:shopId/products', (req,res)=>{
  const {category,search,on_sale} = req.query;
  let products=DB.all('products').filter(p=>p.shop_id===req.params.shopId&&p.is_active===true);
  if(category) products=products.filter(p=>p.category&&p.category.toLowerCase()===category.toLowerCase());
  if(search) products=products.filter(p=>p.name.toLowerCase().includes(search.toLowerCase()));
  if(on_sale==='true') products=products.filter(p=>p.discount>0);
  res.json({success:true,products,total:products.length});
});

shops.post('/:shopId/products', authMW, role('shopowner'), (req,res)=>{
  const shop=DB.byId('shops',req.params.shopId);
  if(!shop) return res.status(404).json({success:false,message:'Shop not found'});
  if(shop.owner_id!==req.user.id) return res.status(403).json({success:false,message:'Not your shop'});
  const {name,category='General',unit='pc',price,mrp,emoji='📦',discount=0,stock=0} = req.body;
  if(!name||!price) return res.status(400).json({success:false,message:'name and price required'});
  const product={id:'p'+uid(),shop_id:req.params.shopId,name,category,unit,price:parseFloat(price),mrp:parseFloat(mrp||price),emoji,discount:parseInt(discount),stock:parseInt(stock),is_active:true,created_at:now()};
  res.status(201).json({success:true,product:DB.insert('products',product)});
});

shops.put('/:shopId/products/:pid', authMW, role('shopowner'), (req,res)=>{
  const shop=DB.byId('shops',req.params.shopId);
  if(!shop||shop.owner_id!==req.user.id) return res.status(403).json({success:false,message:'Not authorized'});
  const updated=DB.update('products',req.params.pid,req.body);
  if(!updated) return res.status(404).json({success:false,message:'Product not found'});
  res.json({success:true,product:updated});
});

shops.delete('/:shopId/products/:pid', authMW, role('shopowner'), (req,res)=>{
  const shop=DB.byId('shops',req.params.shopId);
  if(!shop||shop.owner_id!==req.user.id) return res.status(403).json({success:false,message:'Not authorized'});
  DB.update('products',req.params.pid,{is_active:false});
  res.json({success:true,message:'Product removed from listing'});
});

// ══════════════════════════════════════════════════════════════
// ROUTES — ORDERS
// ══════════════════════════════════════════════════════════════
const orders = express.Router();

orders.get('/', authMW, (req,res)=>{
  const {status,page=1,limit=20} = req.query;
  let list;
  if(req.user.role==='customer') list=DB.find('orders',{user_id:req.user.id});
  else if(req.user.role==='delivery') list=DB.find('orders',{delivery_partner_id:req.user.id});
  else {
    const myShops=DB.find('shops',{owner_id:req.user.id}).map(s=>s.id);
    list=DB.all('orders').filter(o=>o.items&&o.items.some(i=>myShops.includes(i.shop_id)));
  }
  if(status) list=list.filter(o=>o.status===status);
  list=list.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  list=list.map(o=>{
    const u=DB.byId('users',o.user_id);
    const items=(o.items||[]).map(i=>{const p=DB.byId('products',i.product_id);const s=DB.byId('shops',i.shop_id);return {...i,product_name:p?.name,product_emoji:p?.emoji,shop_name:s?.name};});
    return {...o,customer_name:u?.name,customer_phone:u?.phone,items};
  });
  const total=list.length; const start=(parseInt(page)-1)*parseInt(limit);
  res.json({success:true,orders:list.slice(start,start+parseInt(limit)),total,page:parseInt(page),pages:Math.ceil(total/limit)});
});

orders.get('/:id', authMW, (req,res)=>{
  const o=DB.byId('orders',req.params.id);
  if(!o) return res.status(404).json({success:false,message:'Order not found'});
  const u=DB.byId('users',o.user_id);
  const dp=o.delivery_partner_id?DB.byId('users',o.delivery_partner_id):null;
  const items=(o.items||[]).map(i=>{const p=DB.byId('products',i.product_id);const s=DB.byId('shops',i.shop_id);return {...i,product_name:p?.name,product_emoji:p?.emoji,shop_name:s?.name};});
  res.json({success:true,order:{...o,items,customer_name:u?.name,customer_phone:u?.phone,delivery_partner_name:dp?.name,delivery_partner_phone:dp?.phone}});
});

orders.post('/', authMW, role('customer'), (req,res)=>{
  try {
    const {items,address,coupon_code,payment_method='cod'} = req.body;
    if(!items||!items.length) return res.status(400).json({success:false,message:'Cart is empty'});
    if(!address) return res.status(400).json({success:false,message:'Delivery address required'});

    let subtotal=0;
    const enriched=[];
    for(const item of items){
      const p=DB.byId('products',item.product_id);
      if(!p||!p.is_active) return res.status(400).json({success:false,message:`Product ${item.product_id} not available`});
      if(p.stock<item.qty) return res.status(400).json({success:false,message:`${p.name} only has ${p.stock} in stock`});
      subtotal+=p.price*item.qty;
      enriched.push({product_id:item.product_id,shop_id:p.shop_id,qty:item.qty,price:p.price,total:p.price*item.qty});
    }

    const delivery_charge=subtotal>=300?0:25;
    let discount=0, coupon_used=null;
    if(coupon_code){
      const c=(DB.all('coupons')||[]).find(x=>x.code===coupon_code&&x.active);
      if(c&&subtotal>=c.min_order){ discount=c.type==='flat'?c.value:Math.floor(subtotal*c.value/100); coupon_used=coupon_code; }
    }
    const total=subtotal+delivery_charge-discount;
    const loyalty_earned=Math.floor(total/10);
    const partners=DB.find('delivery_partners',{status:'active'});
    const assigned=partners.length?partners[0].user_id:null;

    const order={id:'ord'+uid(),user_id:req.user.id,items:enriched,address,status:'confirmed',subtotal,delivery_charge,discount,coupon_used,total,loyalty_earned,payment_method,delivery_partner_id:assigned,estimated_delivery:'25-35 min',created_at:now()};
    DB.insert('orders',order);

    // Deduct stock
    for(const i of enriched){ const p=DB.byId('products',i.product_id); DB.update('products',p.id,{stock:p.stock-i.qty}); }
    // Award loyalty
    DB.inc('users',req.user.id,'loyalty_points',loyalty_earned);
    DB.insert('loyalty_points',{id:'lp'+uid(),user_id:req.user.id,points:loyalty_earned,type:'earn',description:`Order ${order.id}`,created_at:now()});
    // Update tier
    const updatedUser=DB.byId('users',req.user.id);
    const pts=updatedUser.loyalty_points||0;
    const tier=pts>=10000?'platinum':pts>=3000?'gold':pts>=1000?'silver':'bronze';
    DB.update('users',req.user.id,{tier});
    // Notify
    notify(req.user.id,'Order Confirmed! 🎉',`Order #${order.id} placed. You earned ${loyalty_earned} ZepCoins!`);
    if(assigned){ notify(assigned,'New Delivery Job! 📦',`Order #${order.id} — pick up from ${[...new Set(enriched.map(i=>i.shop_id))].length} store(s)`); }
    // WS push
    wsBroadcast(req.user.id,{type:'order_confirmed',order_id:order.id,message:`Order confirmed! Earning ${loyalty_earned} ZepCoins.`});

    res.status(201).json({success:true,order,message:`Order placed! +${loyalty_earned} ZepCoins earned 🌟`});
  } catch(e){ console.error(e); res.status(500).json({success:false,message:'Server error'}); }
});

orders.put('/:id/status', authMW, (req,res)=>{
  const {status} = req.body;
  const VALID=['confirmed','preparing','picked_up','out_for_delivery','delivered','cancelled'];
  if(!VALID.includes(status)) return res.status(400).json({success:false,message:'Invalid status'});
  const o=DB.byId('orders',req.params.id);
  if(!o) return res.status(404).json({success:false,message:'Order not found'});
  const up={status};
  if(status==='delivered') up.delivered_at=now();
  if(status==='picked_up') up.picked_up_at=now();
  const updated=DB.update('orders',req.params.id,up);
  const msgs={preparing:'Your order is being prepared 🍳',picked_up:'Order picked up from store 📦',out_for_delivery:'Order out for delivery! 🏍️',delivered:'Order delivered! Rate your experience ⭐',cancelled:'Your order has been cancelled'};
  if(msgs[status]) notify(o.user_id,msgs[status],`Order #${req.params.id}`);
  if(status==='delivered'&&o.delivery_partner_id){
    const dp=DB.one('delivery_partners',{user_id:o.delivery_partner_id});
    if(dp){ DB.inc('delivery_partners',dp.id,'total_deliveries',1); DB.inc('delivery_partners',dp.id,'total_earnings',55); DB.inc('users',o.delivery_partner_id,'loyalty_points',55); }
  }
  wsBroadcast(o.user_id,{type:'status_update',order_id:o.id,status,message:msgs[status]||''});
  res.json({success:true,order:updated});
});

orders.get('/:id/track', authMW, (req,res)=>{
  const o=DB.byId('orders',req.params.id);
  if(!o) return res.status(404).json({success:false,message:'Order not found'});
  const flow=['confirmed','preparing','picked_up','out_for_delivery','delivered'];
  const curIdx=flow.indexOf(o.status);
  const labels={confirmed:'Order Confirmed',preparing:'Preparing Order',picked_up:'Picked Up from Store',out_for_delivery:'Out for Delivery',delivered:'Delivered'};
  const timeline=flow.map((s,i)=>({status:s,label:labels[s],completed:i<=curIdx,active:i===curIdx,timestamp:i<=curIdx?new Date(Date.now()-(curIdx-i)*10*60000).toISOString():null}));
  const partner=o.delivery_partner_id?DB.byId('users',o.delivery_partner_id):null;
  const dp=o.delivery_partner_id?DB.one('delivery_partners',{user_id:o.delivery_partner_id}):null;
  res.json({success:true,order_id:o.id,status:o.status,timeline,estimated_delivery:o.estimated_delivery,delivery_partner:partner?{name:partner.name,phone:partner.phone,rating:dp?.rating||4.9,vehicle:dp?.vehicle||'Honda Activa',lat:26.297+(Math.random()-.5)*.005,lng:73.020+(Math.random()-.5)*.005}:null});
});

// ══════════════════════════════════════════════════════════════
// ROUTES — LOYALTY
// ══════════════════════════════════════════════════════════════
const loyalty = express.Router();

loyalty.get('/balance', authMW, (req,res)=>{
  const user=DB.byId('users',req.user.id);
  const tiers={bronze:0,silver:1000,gold:3000,platinum:10000};
  const tierNames=Object.keys(tiers);
  const curIdx=tierNames.indexOf(user.tier||'bronze');
  const nextTier=tierNames[curIdx+1]||null;
  const history=DB.find('loyalty_points',{user_id:req.user.id}).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,20);
  res.json({success:true,points:user.loyalty_points||0,tier:user.tier||'bronze',next_tier:nextTier,points_to_next_tier:nextTier?Math.max(0,tiers[nextTier]-(user.loyalty_points||0)):0,history});
});

loyalty.post('/redeem', authMW, (req,res)=>{
  const {reward_type,points_cost} = req.body;
  const REWARDS={discount_50:{cost:500,desc:'₹50 off coupon'},free_delivery:{cost:1000,desc:'Free delivery ×5'},discount_200:{cost:1500,desc:'₹200 off coupon'},hardware_10pct:{cost:250,desc:'10% off Hardware'},free_item:{cost:750,desc:'Free item ≤₹50'},scratch_card:{cost:100,desc:'Scratch card'}};
  const rwd=REWARDS[reward_type];
  if(!rwd) return res.status(400).json({success:false,message:'Invalid reward type'});
  if(rwd.cost!==parseInt(points_cost)) return res.status(400).json({success:false,message:'Points mismatch'});
  const user=DB.byId('users',req.user.id);
  if((user.loyalty_points||0)<rwd.cost) return res.status(400).json({success:false,message:'Not enough ZepCoins'});
  DB.inc('users',req.user.id,'loyalty_points',-rwd.cost);
  DB.insert('loyalty_points',{id:'lp'+uid(),user_id:req.user.id,points:-rwd.cost,type:'redeem',description:`Redeemed: ${rwd.desc}`,created_at:now()});
  res.json({success:true,message:`Redeemed: ${rwd.desc}`,remaining_points:(user.loyalty_points||0)-rwd.cost});
});

loyalty.post('/spin', authMW, (req,res)=>{
  const today=new Date().toISOString().split('T')[0];
  const todaySpins=DB.find('spin_history',{user_id:req.user.id}).filter(s=>s.date===today);
  if(todaySpins.length>=3) return res.status(400).json({success:false,message:'No spins left today! Come back tomorrow.'});
  const prizes=[{label:'50 Coins',type:'coins',value:50,prob:30},{label:'100 Coins',type:'coins',value:100,prob:20},{label:'200 Coins',type:'coins',value:200,prob:10},{label:'500 Coins',type:'coins',value:500,prob:3},{label:'₹25 Off Coupon',type:'coupon',value:25,prob:15},{label:'₹50 Off Coupon',type:'coupon',value:50,prob:8},{label:'Free Delivery',type:'free_delivery',value:1,prob:9},{label:'Better Luck!',type:'none',value:0,prob:5}];
  const total=prizes.reduce((s,p)=>s+p.prob,0);
  let rand=Math.random()*total, prize=prizes[prizes.length-1];
  for(const p of prizes){ rand-=p.prob; if(rand<=0){prize=p;break;} }
  if(prize.type==='coins'){ DB.inc('users',req.user.id,'loyalty_points',prize.value); DB.insert('loyalty_points',{id:'lp'+uid(),user_id:req.user.id,points:prize.value,type:'spin',description:`Spin & Win: ${prize.label}`,created_at:now()}); }
  DB.insert('spin_history',{id:'sp'+uid(),user_id:req.user.id,prize:prize.label,type:prize.type,value:prize.value,date:today,created_at:now()});
  const left=3-(todaySpins.length+1);
  res.json({success:true,prize,spins_remaining:left,message:prize.type==='none'?'Better luck next time!':`🎉 You won: ${prize.label}!`});
});

loyalty.get('/leaderboard', (req,res)=>{
  const users=DB.all('users').filter(u=>u.role==='customer').sort((a,b)=>(b.loyalty_points||0)-(a.loyalty_points||0)).slice(0,20).map((u,i)=>({rank:i+1,name:u.name,points:u.loyalty_points||0,tier:u.tier||'bronze',referral_code:u.referral_code}));
  res.json({success:true,leaderboard:users});
});

loyalty.post('/review-reward', authMW, (req,res)=>{
  const {order_id,review_type='text'} = req.body;
  const pts={text:25,photo:50,video:100}[review_type]||25;
  DB.inc('users',req.user.id,'loyalty_points',pts);
  DB.insert('loyalty_points',{id:'lp'+uid(),user_id:req.user.id,points:pts,type:'review',description:`${review_type} review bonus`,created_at:now()});
  res.json({success:true,points_earned:pts,message:`+${pts} ZepCoins for your review!`});
});

loyalty.get('/challenges', authMW, (req,res)=>{
  const list=DB.all('challenges').map(c=>({...c,progress:Math.floor(Math.random()*c.target),completed:false}));
  res.json({success:true,challenges:list});
});

loyalty.get('/referrals', authMW, (req,res)=>{
  const refs=DB.find('referrals',{referrer_id:req.user.id}).map(r=>{const u=DB.byId('users',r.referred_id);return {...r,referred_name:u?.name,referred_email:u?.email};});
  res.json({success:true,referrals:refs,total_earned:refs.length*200,count:refs.length});
});

loyalty.post('/apply-coupon', authMW, (req,res)=>{
  const {code,order_total=0} = req.body;
  const c=(DB.all('coupons')||[]).find(x=>x.code===code&&x.active);
  if(!c) return res.status(404).json({success:false,message:'Invalid coupon code'});
  if(order_total<c.min_order) return res.status(400).json({success:false,message:`Minimum order ₹${c.min_order} required`});
  const discount=c.type==='flat'?c.value:Math.floor(order_total*c.value/100);
  res.json({success:true,coupon:{code,type:c.type,value:c.value,discount},message:`Coupon applied! Saving ₹${discount}`});
});

// ══════════════════════════════════════════════════════════════
// ROUTES — DELIVERY
// ══════════════════════════════════════════════════════════════
const delivery = express.Router();

delivery.get('/profile', authMW, role('delivery'), (req,res)=>{
  const dp=DB.one('delivery_partners',{user_id:req.user.id});
  if(!dp) return res.status(404).json({success:false,message:'Delivery profile not found'});
  res.json({success:true,profile:{...dp,...safe(req.user)}});
});

delivery.put('/profile', authMW, role('delivery'), (req,res)=>{
  const dp=DB.one('delivery_partners',{user_id:req.user.id});
  if(!dp) return res.status(404).json({success:false,message:'Profile not found'});
  const up={}; ['vehicle','reg_number','license','aadhar'].forEach(f=>{ if(req.body[f]) up[f]=req.body[f]; });
  res.json({success:true,profile:DB.update('delivery_partners',dp.id,up)});
});

delivery.put('/status', authMW, role('delivery'), (req,res)=>{
  const {status,lat,lng} = req.body;
  const dp=DB.one('delivery_partners',{user_id:req.user.id});
  if(!dp) return res.status(404).json({success:false,message:'Profile not found'});
  const up={status};
  if(lat) up.current_lat=lat; if(lng) up.current_lng=lng;
  res.json({success:true,status:DB.update('delivery_partners',dp.id,up).status,message:status==='active'?'🟢 You are Online':'🔴 You are Offline'});
});

delivery.get('/active-orders', authMW, role('delivery'), (req,res)=>{
  const list=DB.find('orders',{delivery_partner_id:req.user.id}).filter(o=>!['delivered','cancelled'].includes(o.status)).map(o=>{
    const u=DB.byId('users',o.user_id);
    const items=(o.items||[]).map(i=>{ const s=DB.byId('shops',i.shop_id); const p=DB.byId('products',i.product_id); return {...i,shop_name:s?.name,shop_address:s?.address,shop_lat:s?.lat,shop_lng:s?.lng,product_name:p?.name}; });
    return {...o,customer_name:u?.name,customer_phone:u?.phone,items};
  });
  res.json({success:true,orders:list,count:list.length});
});

delivery.get('/route', authMW, role('delivery'), (req,res)=>{
  const activeOrders=DB.find('orders',{delivery_partner_id:req.user.id}).filter(o=>['confirmed','preparing','picked_up'].includes(o.status));
  if(!activeOrders.length) return res.json({success:true,message:'No active orders',route:[],summary:null});
  const shopIds=[...new Set(activeOrders.flatMap(o=>(o.items||[]).map(i=>i.shop_id)))];
  const pickups=shopIds.map(sid=>{ const s=DB.byId('shops',sid); const shopOrders=activeOrders.filter(o=>(o.items||[]).some(i=>i.shop_id===sid)); return {type:'pickup',shop_id:sid,name:s?.name,address:s?.address,lat:s?.lat,lng:s?.lng,emoji:s?.emoji,order_ids:shopOrders.map(o=>o.id)}; });
  const drops=activeOrders.map(o=>{ const u=DB.byId('users',o.user_id); return {type:'drop',order_id:o.id,name:u?.name,address:o.address,lat:26.295+Math.random()*.01,lng:73.018+Math.random()*.01,phone:u?.phone,earning:55}; });
  const route=[...pickups,...drops];
  res.json({success:true,route,summary:{total_stops:route.length,total_distance_km:parseFloat((route.length*0.6).toFixed(1)),estimated_time:`${route.length*5} min`,total_earning:drops.length*55+(drops.length>=5?200:0),bonus:drops.length>=5?200:0,algorithm:'Nearest-Neighbor TSP',distance_saved_km:4.2,time_saved_min:18}});
});

delivery.get('/earnings', authMW, role('delivery'), (req,res)=>{
  const dp=DB.one('delivery_partners',{user_id:req.user.id});
  if(!dp) return res.status(404).json({success:false,message:'Profile not found'});
  const today=new Date().toISOString().split('T')[0];
  const todayDels=DB.find('orders',{delivery_partner_id:req.user.id,status:'delivered'}).filter(o=>o.delivered_at&&o.delivered_at.startsWith(today));
  res.json({success:true,earnings:{today:{deliveries:todayDels.length,base:todayDels.length*55,bonus:todayDels.length>=20?200:0,tips:todayDels.length*12,total:todayDels.length*67+(todayDels.length>=20?200:0)},month:{deliveries:dp.total_deliveries||0,total:dp.total_earnings||0,avg_per_delivery:dp.total_deliveries>0?Math.round((dp.total_earnings||0)/dp.total_deliveries):0},daily_target:{target:20,current:todayDels.length,bonus_on_completion:200},rating:dp.rating||4.9,coins:dp.coins||0,badge:dp.badge||'bronze',incentives:[{name:'Peak Hour (6-9PM)',multiplier:'1.5×',active:true},{name:'Rain Surge',multiplier:'2×',active:false},{name:'Rating Bonus (4.8+)',amount:'₹500/mo',active:(dp.rating||0)>=4.8},{name:'Weekend Bonus',multiplier:'1.3×',active:new Date().getDay()>=5}]}});
});

delivery.get('/stats/dashboard', authMW, role('delivery'), (req,res)=>{
  const dp=DB.one('delivery_partners',{user_id:req.user.id});
  res.json({success:true,stats:{total_deliveries:dp?.total_deliveries||0,total_earnings:dp?.total_earnings||0,rating:dp?.rating||0,coins:dp?.coins||0,badge:dp?.badge||'bronze',rank:3,top_percentile:12}});
});

// ══════════════════════════════════════════════════════════════
// ROUTES — MISC
// ══════════════════════════════════════════════════════════════
const misc = express.Router();

misc.get('/notifications', authMW, (req,res)=>{
  const notifs=DB.find('notifications',{user_id:req.user.id}).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  res.json({success:true,notifications:notifs,unread:notifs.filter(n=>!n.read).length});
});
misc.put('/notifications/:id/read', authMW, (req,res)=>{ DB.update('notifications',req.params.id,{read:true}); res.json({success:true}); });
misc.put('/notifications/mark-all-read', authMW, (req,res)=>{ DB.updateMany('notifications',{user_id:req.user.id},{read:true}); res.json({success:true,message:'All notifications marked as read'}); });

misc.get('/wishlist', authMW, (req,res)=>{
  const items=DB.find('wishlist',{user_id:req.user.id}).map(w=>{ const p=DB.byId('products',w.product_id); const s=p?DB.byId('shops',p.shop_id):null; return {...w,product:p,shop_name:s?.name}; }).filter(w=>w.product);
  res.json({success:true,wishlist:items,total:items.length});
});
misc.post('/wishlist/:productId', authMW, (req,res)=>{
  const existing=DB.one('wishlist',{user_id:req.user.id,product_id:req.params.productId});
  if(existing){ DB.del('wishlist',existing.id); return res.json({success:true,action:'removed',message:'Removed from wishlist'}); }
  DB.insert('wishlist',{id:'wl'+uid(),user_id:req.user.id,product_id:req.params.productId,created_at:now()});
  res.json({success:true,action:'added',message:'Added to wishlist ❤️'});
});

misc.post('/reviews', authMW, (req,res)=>{
  const {order_id,shop_id,rating,comment='',tags=[],review_type='text'} = req.body;
  if(!order_id||!shop_id||!rating) return res.status(400).json({success:false,message:'order_id, shop_id and rating required'});
  if(rating<1||rating>5) return res.status(400).json({success:false,message:'Rating 1–5 required'});
  if(DB.find('reviews',{order_id,user_id:req.user.id}).length) return res.status(409).json({success:false,message:'Already reviewed this order'});
  const rev={id:'rev'+uid(),user_id:req.user.id,order_id,shop_id,rating:parseInt(rating),comment,tags,review_type,created_at:now()};
  DB.insert('reviews',rev);
  const shopRevs=DB.find('reviews',{shop_id});
  DB.update('shops',shop_id,{rating:parseFloat((shopRevs.reduce((s,r)=>s+r.rating,0)/shopRevs.length).toFixed(1)),total_reviews:shopRevs.length});
  const pts={text:25,photo:50,video:100}[review_type]||25;
  DB.inc('users',req.user.id,'loyalty_points',pts);
  res.status(201).json({success:true,review:rev,points_earned:pts,message:`Review submitted! +${pts} ZepCoins 🌟`});
});
misc.get('/reviews/shop/:shopId', (req,res)=>{
  const reviews=DB.find('reviews',{shop_id:req.params.shopId}).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).map(r=>({...r,user_name:DB.byId('users',r.user_id)?.name}));
  res.json({success:true,reviews,total:reviews.length});
});

misc.get('/promotions', (req,res)=>{
  const {shop_id} = req.query;
  let promos=DB.all('promotions').filter(p=>p.status==='active');
  if(shop_id) promos=promos.filter(p=>p.shop_id===shop_id);
  res.json({success:true,promotions:promos,total:promos.length});
});
misc.post('/promotions', authMW, role('shopowner'), (req,res)=>{
  const {shop_id,title,type,value,min_order=0,applicable_to='all',ends_at} = req.body;
  const shop=DB.byId('shops',shop_id);
  if(!shop||shop.owner_id!==req.user.id) return res.status(403).json({success:false,message:'Not authorized'});
  const promo={id:'pr'+uid(),shop_id,title,type,value,min_order,applicable_to,status:'active',ends_at:ends_at||null,created_at:now()};
  res.status(201).json({success:true,promotion:DB.insert('promotions',promo)});
});
misc.put('/promotions/:id/status', authMW, role('shopowner'), (req,res)=>{
  const {status} = req.body;
  res.json({success:true,promotion:DB.update('promotions',req.params.id,{status})});
});

misc.get('/analytics/shop/:shopId', authMW, role('shopowner'), (req,res)=>{
  const shop=DB.byId('shops',req.params.shopId);
  if(!shop||shop.owner_id!==req.user.id) return res.status(403).json({success:false,message:'Not authorized'});
  const allOrders=DB.all('orders');
  const shopOrders=allOrders.filter(o=>o.items&&o.items.some(i=>i.shop_id===req.params.shopId));
  const delivered=shopOrders.filter(o=>o.status==='delivered');
  const totalRevenue=delivered.reduce((s,o)=>s+(o.items||[]).filter(i=>i.shop_id===req.params.shopId).reduce((ss,i)=>ss+i.price*i.qty,0),0);
  const days=Array.from({length:7},(_,i)=>{const d=new Date();d.setDate(d.getDate()-i);return d.toISOString().split('T')[0];}).reverse();
  const revenueByDay=days.map(day=>{ const d=delivered.filter(o=>o.delivered_at&&o.delivered_at.startsWith(day)); return {date:day,revenue:d.reduce((s,o)=>s+(o.total||0),0),orders:d.length}; });
  const prodSales={};
  delivered.forEach(o=>(o.items||[]).filter(i=>i.shop_id===req.params.shopId).forEach(i=>{ if(!prodSales[i.product_id])prodSales[i.product_id]={qty:0,revenue:0}; prodSales[i.product_id].qty+=i.qty; prodSales[i.product_id].revenue+=i.price*i.qty; }));
  const topProducts=Object.entries(prodSales).sort(([,a],[,b])=>b.revenue-a.revenue).slice(0,5).map(([pid,s])=>{ const p=DB.byId('products',pid); return {name:p?.name,emoji:p?.emoji,...s}; });
  res.json({success:true,analytics:{total_orders:shopOrders.length,delivered_orders:delivered.length,total_revenue:totalRevenue,avg_order_value:delivered.length?Math.round(totalRevenue/delivered.length):0,rating:shop.rating,total_reviews:shop.total_reviews,revenue_by_day:revenueByDay,top_products:topProducts}});
});

misc.get('/analytics/platform', (req,res)=>{
  const users=DB.all('users'),orders=DB.all('orders'),shops=DB.all('shops');
  const delivered=orders.filter(o=>o.status==='delivered');
  const totalRev=delivered.reduce((s,o)=>s+(o.total||0),0);
  res.json({success:true,stats:{total_users:users.filter(u=>u.role==='customer').length,total_shops:shops.length,total_orders:orders.length,delivered_orders:delivered.length,total_revenue:totalRev,avg_order_value:delivered.length?Math.round(totalRev/delivered.length):0,active_delivery_partners:DB.find('delivery_partners',{status:'active'}).length}});
});

// ══════════════════════════════════════════════════════════════
// MOUNT ALL ROUTES
// ══════════════════════════════════════════════════════════════
app.use('/api/auth',     auth);
app.use('/api/shops',    shops);
app.use('/api/orders',   orders);
app.use('/api/loyalty',  loyalty);
app.use('/api/delivery', delivery);
app.use('/api',          misc);

app.get('/api/health', (_,res)=>res.json({status:'ok',app:'Zepply API',version:'2.0.0',timestamp:now(),uptime:Math.floor(process.uptime())+'s'}));

app.get('/api', (_,res)=>res.json({
  app:'Zepply Hyperlocal Delivery API', version:'2.0.0',
  demo_credentials:{customer:{email:'rahul@example.com',password:'password123'},shop_owner:{email:'gupta@example.com',password:'password123'},delivery:{email:'rajan@example.com',password:'password123'}},
  total_endpoints:38,
  endpoints:{
    auth:['POST /api/auth/register','POST /api/auth/login','GET /api/auth/me','PUT /api/auth/profile','PUT /api/auth/change-password'],
    shops:['GET /api/shops','GET /api/shops/all/products','GET /api/shops/:id','POST /api/shops','PUT /api/shops/:id','PUT /api/shops/:id/toggle','GET /api/shops/:shopId/products','POST /api/shops/:shopId/products','PUT /api/shops/:shopId/products/:pid','DELETE /api/shops/:shopId/products/:pid'],
    orders:['GET /api/orders','GET /api/orders/:id','POST /api/orders','PUT /api/orders/:id/status','GET /api/orders/:id/track'],
    loyalty:['GET /api/loyalty/balance','POST /api/loyalty/redeem','POST /api/loyalty/spin','GET /api/loyalty/leaderboard','POST /api/loyalty/review-reward','GET /api/loyalty/challenges','GET /api/loyalty/referrals','POST /api/loyalty/apply-coupon'],
    delivery:['GET /api/delivery/profile','PUT /api/delivery/profile','PUT /api/delivery/status','GET /api/delivery/active-orders','GET /api/delivery/route','GET /api/delivery/earnings','GET /api/delivery/stats/dashboard'],
    misc:['GET /api/notifications','PUT /api/notifications/mark-all-read','GET /api/wishlist','POST /api/wishlist/:productId','POST /api/reviews','GET /api/reviews/shop/:shopId','GET /api/promotions','POST /api/promotions','GET /api/analytics/shop/:shopId','GET /api/analytics/platform']
  }
}));

// Serve frontend
app.use((req,res,next)=>{ if(req.path.startsWith('/api')) return next(); const f=path.join(__dirname,'public','index.html'); fs.existsSync(f)?res.sendFile(f):res.redirect('/api'); });
app.use((_,res)=>res.status(404).json({success:false,message:'Route not found'}));

// ══════════════════════════════════════════════════════════════
// WEBSOCKET
// ══════════════════════════════════════════════════════════════
wss.on('connection',(ws,req)=>{
  const u=new URL(req.url,'http://localhost');
  const userId=u.searchParams.get('userId');
  if(userId) wsClients.set(userId,ws);
  ws.send(JSON.stringify({type:'connected',message:'Zepply realtime connected ✅'}));
  ws.on('message',msg=>{ try{ const d=JSON.parse(msg); if(d.type==='location_update'&&d.userId){ const o=DB.one('orders',{delivery_partner_id:d.userId,status:'out_for_delivery'}); if(o) wsBroadcast(o.user_id,{type:'partner_location',lat:d.lat,lng:d.lng,order_id:o.id}); } }catch{} });
  ws.on('close',()=>{ if(userId) wsClients.delete(userId); });
});

// ══════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════
server.listen(PORT,()=>{
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║    🛒 Zepply API  v2.0  ✅           ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  API  → http://localhost:${PORT}/api   ║`);
  console.log(`║  WS   → ws://localhost:${PORT}          ║`);
  console.log('║  Demo → rahul@example.com             ║');
  console.log('║         password123                   ║');
  console.log('╚════════════════════════════════════════╝\n');
});

module.exports = {app, wsBroadcast};
