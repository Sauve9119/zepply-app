const express = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const router = express.Router();
const db = require('../middleware/db');
const { auth, requireRole } = require('../middleware/auth');
const { markupPrice, coinsEarnedForTotal, DELIVERY_CHARGE_RS, DELIVERY_PARTNER_PAYOUT_RS, FREE_DELIVERY_THRESHOLD_RS } = require('../middleware/pricing');

// Haversine distance in km between two coordinates
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// FIX: estimated_delivery pehle hamesha '25-35 min' hardcoded tha, distance ya
// shop count se koi lena dena nahi tha. Ab agar customer coordinates diye gaye
// hain toh real distance se estimate karte hain (farthest pickup shop se);
// warna involved shops ki count ke hisaab se ek sensible fallback deते hain.
function estimateDeliveryWindow(shopIds, custLat, custLng) {
  const AVG_SPEED_KMPH = 20; // city traffic average
  const PREP_MIN = 10; // pehli shop ke liye prep + pickup buffer
  const EXTRA_SHOP_MIN = 6; // har additional shop pickup ke liye extra time

  const shops = shopIds.map(id => db.findById('shops', id)).filter(Boolean);
  const hasCoords = custLat != null && custLng != null && shops.some(s => s.lat && s.lng);

  let baseMin;
  if (hasCoords) {
    const distances = shops
      .filter(s => s.lat && s.lng)
      .map(s => distanceKm(s.lat, s.lng, parseFloat(custLat), parseFloat(custLng)));
    const maxDist = distances.length ? Math.max(...distances) : 2; // 2km sensible default
    baseMin = PREP_MIN + (maxDist / AVG_SPEED_KMPH) * 60;
  } else {
    baseMin = PREP_MIN + 10; // no coords — assume a short-ish local hop
  }
  baseMin += Math.max(0, shopIds.length - 1) * EXTRA_SHOP_MIN;

  const low = Math.max(10, Math.round(baseMin / 5) * 5);
  const high = low + 10;
  return `${low}-${high} min`;
}

// SECURITY FIX: pehle order ka total client-side (frontend JS) mein calculate
// hota tha aur seedha Razorpay checkout ko de diya jaata tha — koi bhi
// devtools se amount tamper kar sakta tha. Ab yeh shared function server-side
// hi price nikalta hai (products/coupon DB se), jise create-payment-intent aur
// COD order dono use karte hain — client ka number kabhi trust nahi karte.
function computePricing(userId, items, coupon_code, custLat, custLng) {
  let subtotal = 0;
  let totalShopPayout = 0;
  const enrichedItems = [];
  const MAX_DELIVERY_RADIUS_KM = 10;

  for (const item of items) {
    const product = db.findById('products', item.product_id);
    if (!product || !product.is_active)
      return { error: `Product ${item.product_id} not available` };
    if (product.stock < item.qty)
      return { error: `${product.name} mein sirf ${product.stock} bacha hai` };

    // FIX: pehle koi bhi shehar se customer order kar sakta tha (jaise Kanpur
    // se Jaipur ki shop pe) — sirf frontend browse filter tha jo API call se
    // bypass ho sakta tha. Ab yahan server-side hard check hai: agar customer
    // location diya hai aur shop us radius se bahar hai, order reject hota hai.
    const shop = db.findById('shops', product.shop_id);
    if (custLat != null && custLng != null && shop && typeof shop.lat === 'number' && typeof shop.lng === 'number' && shop.lat !== 0 && shop.lng !== 0) {
      const dist = distanceKm(shop.lat, shop.lng, parseFloat(custLat), parseFloat(custLng));
      if (dist > MAX_DELIVERY_RADIUS_KM) {
        return { error: `${shop.name} aapki delivery range (${MAX_DELIVERY_RADIUS_KM}km) se bahar hai — ${dist.toFixed(1)}km door hai` };
      }
    }

    // FIX: pehle jo price shop ne set kiya wahi customer se seedha liya jaata
    // tha — platform ka koi commission hi track nahi hota tha. Ab shop ka base
    // price (unka payout) alag hai, customer ko commission-inclusive price
    // dikhta/bikta hai, aur order pe dono track hote hain settlement ke liye.
    const unitCustomerPrice = markupPrice(product.price);
    const itemTotal = unitCustomerPrice * item.qty;
    const shopPayout = product.price * item.qty;
    subtotal += itemTotal;
    totalShopPayout += shopPayout;
    enrichedItems.push({
      product_id: item.product_id, shop_id: product.shop_id, qty: item.qty,
      price: unitCustomerPrice,       // customer-facing unit price (commission included)
      shop_unit_price: product.price, // shop ka apna base price (unka payout)
      total: itemTotal, shop_payout: shopPayout
    });
  }

  const delivery_charge = subtotal >= FREE_DELIVERY_THRESHOLD_RS ? 0 : DELIVERY_CHARGE_RS;

  let discount = 0, coupon_used = null;
  if (coupon_code) {
    const coupon = db.findAll('coupons').find(c => c.code === coupon_code && c.active);
    if (coupon) {
      if (subtotal < coupon.min_order) return { error: `Minimum order ₹${coupon.min_order} chahiye` };
      if (coupon.max_uses && (coupon.used || 0) >= coupon.max_uses) return { error: 'Coupon limit khatam ho gaya' };
      const alreadyUsed = db.findAll('orders').some(o => o.coupon_used === coupon_code && o.user_id === userId && o.status !== 'cancelled');
      if (alreadyUsed) return { error: 'Aap ye coupon pehle use kar chuke hain' };
      discount = coupon.type === 'flat' ? coupon.value : Math.floor(subtotal * coupon.value / 100);
      coupon_used = coupon_code;
    }
  }

  const total = subtotal + delivery_charge - discount;
  // Platform commission = item markup (subtotal - shop payout) + delivery margin (charge - partner payout)
  const deliveryMargin = delivery_charge > 0 ? Math.max(0, delivery_charge - DELIVERY_PARTNER_PAYOUT_RS) : 0;
  const platform_commission = (subtotal - totalShopPayout) + deliveryMargin;
  return { subtotal, delivery_charge, discount, coupon_used, total, enrichedItems, shop_payout_total: totalShopPayout, platform_commission };
}


// GET /api/orders
router.get('/', auth, (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  let orders;

  if (req.user.role === 'customer') {
    // Customer: sirf apne orders
    orders = db.find('orders', { user_id: req.user.id });

  } else if (req.user.role === 'shopowner') {
    // FIX: Shopowner ko UNKI SHOP ke saare orders dikhne chahiye
    // Chahe customer koi bhi ho
    const myShops = db.find('shops', { owner_id: req.user.id }).map(s => s.id);
    orders = db.findAll('orders').filter(o =>
      o.items && o.items.some(i => myShops.includes(i.shop_id))
    );

  } else if (req.user.role === 'delivery') {
    // FIX: Delivery ko 2 tarah ke orders dikhne chahiye:
    // 1. Unke assigned orders (jo unhone accept kiye)
    // 2. Available (unassigned) orders jo koi bhi accept kar sakta hai
    const myOrders = db.find('orders', { delivery_partner_id: req.user.id });
    const availableOrders = db.findAll('orders').filter(o =>
      !o.delivery_partner_id &&
      !['delivered', 'cancelled'].includes(o.status)
    );
    // Dono merge karo, duplicates hatao
    const seen = new Set();
    orders = [...myOrders, ...availableOrders].filter(o => {
      if (seen.has(o.id)) return false;
      seen.add(o.id);
      return true;
    });
  } else {
    orders = [];
  }

  if (status) orders = orders.filter(o => o.status === status);
  orders = orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  orders = orders.map(o => {
    const user = db.findById('users', o.user_id);
    const items = (o.items || []).map(item => {
      const product = db.findById('products', item.product_id);
      const shop = db.findById('shops', item.shop_id);
      return { ...item, product_name: product?.name, product_emoji: product?.emoji, shop_name: shop?.name, shop_lat: shop?.lat, shop_lng: shop?.lng };
    });
    return {
      ...o,
      customer_name: user?.name,
      customer_phone: user?.phone,
      delivery_partner_name: o.delivery_partner_id ? (()=>{ const dp=db.findById('users',o.delivery_partner_id); return dp?.name; })() : null,
      delivery_partner_phone: o.delivery_partner_id ? (()=>{ const dp=db.findById('users',o.delivery_partner_id); return dp?.phone; })() : null,
      shop_owner_phone: (()=>{ const shopId=(o.items||[])[0]?.shop_id; const shop=shopId?db.findById('shops',shopId):null; const owner=shop?db.findById('users',shop.owner_id):null; return owner?.phone; })(),
      shop_owner_name: (()=>{ const shopId=(o.items||[])[0]?.shop_id; const shop=shopId?db.findById('shops',shopId):null; const owner=shop?db.findById('users',shop.owner_id):null; return owner?.name; })(),
      shop_address: (()=>{ const shopId=(o.items||[])[0]?.shop_id; const shop=shopId?db.findById('shops',shopId):null; return shop?.address; })(),
      items,
      is_available: !o.delivery_partner_id,
      is_mine: o.delivery_partner_id === req.user.id
    };
  });

  const total = orders.length;
  const start = (parseInt(page) - 1) * parseInt(limit);
  res.json({ success: true, orders: orders.slice(start, start + parseInt(limit)), total, page: parseInt(page), pages: Math.ceil(total / limit) });
});

// GET /api/orders/:id
router.get('/:id', auth, (req, res) => {
  const order = db.findById('orders', req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

  if (req.user.role === 'customer' && order.user_id !== req.user.id)
    return res.status(403).json({ success: false, message: 'Access denied' });

  if (req.user.role === 'shopowner') {
    const myShops = db.find('shops', { owner_id: req.user.id }).map(s => s.id);
    if (!order.items || !order.items.some(i => myShops.includes(i.shop_id)))
      return res.status(403).json({ success: false, message: 'Access denied' });
  }

  const items = (order.items || []).map(item => {
    const product = db.findById('products', item.product_id);
    const shop = db.findById('shops', item.shop_id);
    return { ...item, product_name: product?.name, product_emoji: product?.emoji, shop_name: shop?.name };
  });
  const user = db.findById('users', order.user_id);
  const partner = order.delivery_partner_id ? db.findById('users', order.delivery_partner_id) : null;

  res.json({ success: true, order: { ...order, items, customer_name: user?.name, customer_phone: user?.phone, delivery_partner_name: partner?.name, delivery_partner_phone: partner?.phone } });
});

// POST /api/orders/:id/accept — Delivery partner order accept kare
// Jo pehle accept kare usko milega
router.post('/:id/accept', auth, requireRole('delivery'), (req, res) => {
  const order = db.findById('orders', req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

  // Agar already kisi ne accept kar liya
  if (order.delivery_partner_id)
    return res.status(409).json({ success: false, message: 'Ye order pehle hi kisi aur ne accept kar liya!' });

  if (['delivered', 'cancelled'].includes(order.status))
    return res.status(400).json({ success: false, message: 'Ye order available nahi hai' });

  // FIX: pehle accept karte hi status seedha 'preparing' force ho jaata tha,
  // chahe shop ne abhi kuch shuru bhi na kiya ho. Ab accept sirf delivery
  // partner assign karta hai — order ka status waisa hi rehta hai jaisa tha,
  // shop hi 'preparing' → 'ready' transitions control karta hai.
  const updated = db.updateById('orders', req.params.id, {
    delivery_partner_id: req.user.id
  });

  // Customer ko notify karo
  db.insert('notifications', {
    id: 'n' + uuidv4().slice(0, 8),
    user_id: order.user_id,
    title: 'Delivery Partner Assign Ho Gaya! 🏍️',
    body: `${req.user.name} aapka order deliver karenge`,
    read: false,
    created_at: new Date().toISOString()
  });

  res.json({ success: true, order: updated, message: 'Order accept kar liya! Customer ko notify kar diya.' });
});

// POST /api/orders/create-payment-intent — online payment se pehle server-side
// pricing lock karo aur Razorpay ka order banao. Amount kabhi frontend se nahi
// aata — hamesha yahin DB se recompute hota hai.
router.post('/create-payment-intent', auth, requireRole('customer'), async (req, res) => {
  try {
    const { items, coupon_code, lat, lng } = req.body;
    if (!items || !items.length) return res.status(400).json({ success: false, message: 'Cart is empty' });

    const pricing = computePricing(req.user.id, items, coupon_code, lat, lng);
    if (pricing.error) return res.status(400).json({ success: false, message: pricing.error });

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      return res.status(503).json({ success: false, message: 'Online payment abhi configure nahi hai. COD use karo.' });
    }

    const intentId = 'pi' + uuidv4().slice(0, 8);
    const auth64 = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth64}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: Math.round(pricing.total * 100), currency: 'INR', receipt: intentId })
    });
    if (!rzpRes.ok) {
      const errText = await rzpRes.text();
      console.error('Razorpay order create error:', rzpRes.status, errText);
      return res.status(502).json({ success: false, message: 'Payment gateway se order create nahi hua' });
    }
    const rzpOrder = await rzpRes.json();

    db.insert('payment_intents', {
      id: intentId,
      razorpay_order_id: rzpOrder.id,
      user_id: req.user.id,
      items: pricing.enrichedItems,
      coupon_code: pricing.coupon_used,
      subtotal: pricing.subtotal,
      delivery_charge: pricing.delivery_charge,
      discount: pricing.discount,
      total: pricing.total,
      shop_payout_total: pricing.shop_payout_total,
      platform_commission: pricing.platform_commission,
      used: false,
      created_at: new Date().toISOString()
    });

    res.json({ success: true, key: keyId, razorpay_order_id: rzpOrder.id, amount: rzpOrder.amount, currency: rzpOrder.currency, total: pricing.total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/orders — place new order
router.post('/', auth, requireRole('customer'), (req, res) => {
  try {
    const { items, address, coupon_code, payment_method = 'cod', lat, lng, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!address) return res.status(400).json({ success: false, message: 'Delivery address required' });

    let pricing, coupon_used_final = null;

    if (payment_method === 'online') {
      // SECURITY FIX: pehle yahan koi verification nahi hoti thi — client jo bhi
      // razorpay_payment_id bhej de, order bana ke stock deduct ho jaata tha,
      // payment_status hamesha 'awaiting_payment' pe atka rehta tha (kabhi 'paid'
      // nahi hota tha). Ab HMAC signature verify karte hain aur amount/items
      // create-payment-intent step pe locked hue intent record se aate hain —
      // client dobara items/price nahi bhej sakta.
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
        return res.status(400).json({ success: false, message: 'Payment details missing' });

      const keySecret = process.env.RAZORPAY_KEY_SECRET;
      if (!keySecret) return res.status(503).json({ success: false, message: 'Online payment configure nahi hai' });

      const expectedSig = crypto.createHmac('sha256', keySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');
      if (expectedSig !== razorpay_signature)
        return res.status(400).json({ success: false, message: 'Payment verification fail hui' });

      const intent = db.findOne('payment_intents', { razorpay_order_id });
      if (!intent || intent.user_id !== req.user.id)
        return res.status(400).json({ success: false, message: 'Payment intent not found' });
      if (intent.used)
        return res.status(409).json({ success: false, message: 'Ye payment pehle hi use ho chuki hai' });

      // Stock dobara verify karo — intent banne ke baad se stock khatam ho sakta hai
      for (const item of intent.items) {
        const product = db.findById('products', item.product_id);
        if (!product || !product.is_active || product.stock < item.qty) {
          // Paisa capture ho chuka hai par stock nahi hai — manual refund flag karo
          db.updateById('payment_intents', intent.id, { used: true, stock_conflict: true });
          console.error(`⚠️ STOCK CONFLICT after payment capture — razorpay_payment_id=${razorpay_payment_id}, refund manually check karo`);
          return res.status(409).json({ success: false, message: `Stock khatam ho gaya — payment ${razorpay_payment_id} ka refund process ho raha hai, 3-5 din mein wapas milega` });
        }
      }

      pricing = { subtotal: intent.subtotal, delivery_charge: intent.delivery_charge, discount: intent.discount, total: intent.total, enrichedItems: intent.items, shop_payout_total: intent.shop_payout_total, platform_commission: intent.platform_commission };
      coupon_used_final = intent.coupon_code;
      db.updateById('payment_intents', intent.id, { used: true });
    } else {
      if (!items || !items.length) return res.status(400).json({ success: false, message: 'Cart is empty' });
      pricing = computePricing(req.user.id, items, coupon_code, lat, lng);
      if (pricing.error) return res.status(400).json({ success: false, message: pricing.error });
      coupon_used_final = pricing.coupon_used;
    }

    const { subtotal, delivery_charge, discount, total, enrichedItems, shop_payout_total, platform_commission } = pricing;

    if (coupon_used_final) {
      const coupon = db.findAll('coupons').find(c => c.code === coupon_used_final && c.active);
      if (coupon) db.updateById('coupons', coupon.id, { used: (coupon.used || 0) + 1 });
    }

    // FIX: pehle loyalty_earned = total/10 tha (bina kisi documented rate ke).
    // Ab explicit 5% cashback hai, 100 ZepCoins = ₹1 ki dar se.
    const loyalty_earned = coinsEarnedForTotal(total);
    const orderId = 'ord' + uuidv4().slice(0, 8);
    const orderShopIds = [...new Set(enrichedItems.map(i => i.shop_id))];
    const estimated_delivery = estimateDeliveryWindow(orderShopIds, lat, lng);

    // FIX: Order unassigned rakho — delivery partner khud accept karega
    const order = {
      id: orderId, user_id: req.user.id, items: enrichedItems, address,
      status: 'confirmed', subtotal, delivery_charge, discount, coupon_used: coupon_used_final,
      total, loyalty_earned, payment_method,
      payment_status: payment_method === 'cod' ? 'pending' : 'paid',
      razorpay_order_id: razorpay_order_id || null,
      razorpay_payment_id: razorpay_payment_id || null,
      delivery_partner_id: null, // Koi assign nahi — delivery wale khud accept karenge
      delivery_partner_payout: DELIVERY_PARTNER_PAYOUT_RS, // partner ko hamesha milta hai, chahe customer ko free delivery mili ho
      shop_payout_total, platform_commission, // settlement/accounting ke liye
      estimated_delivery,
      created_at: new Date().toISOString()
    };

    db.insert('orders', order);

    // Stock deduct karo
    for (const item of enrichedItems) {
      const product = db.findById('products', item.product_id);
      db.updateById('products', item.product_id, { stock: product.stock - item.qty });
    }

    // Loyalty points
    db.increment('users', req.user.id, 'loyalty_points', loyalty_earned);
    db.insert('loyalty_points', { id: 'lp' + uuidv4().slice(0, 8), user_id: req.user.id, points: loyalty_earned, type: 'earn', description: `Order ${orderId}`, created_at: new Date().toISOString() });

    // Tier update
    const user = db.findById('users', req.user.id);
    const pts = user.loyalty_points || 0;
    const tier = pts >= 10000 ? 'platinum' : pts >= 3000 ? 'gold' : pts >= 1000 ? 'silver' : 'bronze';
    db.updateById('users', req.user.id, { tier });

    // Customer notification — DB + WS
    db.insert('notifications', { id: 'n' + uuidv4().slice(0, 8), user_id: req.user.id, title: 'Order Confirmed! 🎉', body: `Order #${orderId} confirm hua. +${loyalty_earned} ZepCoins mile!`, read: false, created_at: new Date().toISOString() });
    req.wsBroadcast(req.user.id, { type: 'order_confirmed', message: `✅ Order #${orderId.slice(-6).toUpperCase()} confirmed! +${loyalty_earned} coins`, order_id: orderId });
    req.sendPush(req.user.id, 'Order Confirmed! 🎉', `Order #${orderId.slice(-6).toUpperCase()} place hua. +${loyalty_earned} ZepCoins!`, 'order');

    // Shop owners ko notify karo (jinke products order mein hain)
    const shopIdsInOrder = [...new Set(enrichedItems.map(i => i.shop_id))];
    const allShops = db.findAll('shops').filter(s => shopIdsInOrder.includes(s.id));
    for (const shop of allShops) {
      const notifBody = `Naya order! #${orderId.slice(-6).toUpperCase()} — ₹${total} — ${enrichedItems.filter(i=>i.shop_id===shop.id).map(i=>i.product_name+' ×'+i.qty).join(', ')}`;
      db.insert('notifications', { id: 'n' + uuidv4().slice(0, 8), user_id: shop.owner_id, title: 'Naya Order Aaya! 🛒', body: notifBody, read: false, created_at: new Date().toISOString() });
      req.wsBroadcast(shop.owner_id, { type: 'new_order', message: '🛒 ' + notifBody, order_id: orderId });
      req.sendPush(shop.owner_id, 'Naya Order Aaya! 🛒', notifBody, 'new-order');
    }

    // Delivery partners ko notify NAHI karenge abhi — shop owner accept karne ke baad karenge

    res.status(201).json({ success: true, order, message: `Order place hua! +${loyalty_earned} ZepCoins mile 🌟` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/orders/:id/status
router.put('/:id/status', auth, (req, res) => {
  try {
    const { status } = req.body;
    // FIX: pehle 'ready' naam ka koi status hi nahi tha, aur koi transition
    // validation nahi thi — delivery partner order 'confirmed' rehte hue hi
    // seedha 'picked_up' mark kar sakta tha, shop ne ready kiya ho ya na ho.
    // Ab explicit 'ready' status hai aur sirf allowed next-steps hi accept hote hain.
    const VALID = ['confirmed', 'preparing', 'ready', 'picked_up', 'out_for_delivery', 'delivered', 'cancelled'];
    if (!VALID.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });

    const order = db.findById('orders', req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Shopowner sirf apni shop ka status update kar sakta hai
    if (req.user.role === 'shopowner') {
      const myShops = db.find('shops', { owner_id: req.user.id }).map(s => s.id);
      if (!order.items || !order.items.some(i => myShops.includes(i.shop_id)))
        return res.status(403).json({ success: false, message: 'Access denied' });
      if (!['preparing', 'ready', 'cancelled'].includes(status))
        return res.status(403).json({ success: false, message: 'Shop sirf preparing/ready/cancelled set kar sakta hai' });
    }
    // Delivery sirf apna assigned order, aur sirf pickup/enroute/delivered update kar sakta hai
    if (req.user.role === 'delivery') {
      if (order.delivery_partner_id !== req.user.id)
        return res.status(403).json({ success: false, message: 'Pehle order accept karo' });
      if (!['picked_up', 'out_for_delivery', 'delivered'].includes(status))
        return res.status(403).json({ success: false, message: 'Delivery partner sirf pickup/enroute/delivered set kar sakta hai' });
    }
    // Customer sirf cancel kar sakta hai, aur sirf pickup se pehle
    if (req.user.role === 'customer') {
      if (status !== 'cancelled') return res.status(403).json({ success: false, message: 'Customer sirf cancel kar sakta hai' });
      if (['picked_up', 'out_for_delivery', 'delivered'].includes(order.status))
        return res.status(400).json({ success: false, message: 'Pickup ke baad order cancel nahi ho sakta' });
    }

    // Sequential transition enforce karo — status kabhi step skip nahi kar sakta
    const STATUS_TRANSITIONS = {
      confirmed: ['preparing', 'cancelled'],
      preparing: ['ready', 'cancelled'],
      ready: ['picked_up', 'cancelled'],
      picked_up: ['out_for_delivery'],
      out_for_delivery: ['delivered'],
      delivered: [],
      cancelled: []
    };
    const allowedNext = STATUS_TRANSITIONS[order.status] || [];
    if (!allowedNext.includes(status)) {
      return res.status(400).json({ success: false, message: `Order abhi '${order.status}' hai, seedha '${status}' pe nahi ja sakta` });
    }

    // Cancel pe sab wapas karo
    if (status === 'cancelled' && order.status !== 'cancelled') {
      for (const item of (order.items || [])) {
        const product = db.findById('products', item.product_id);
        if (product) db.updateById('products', item.product_id, { stock: product.stock + item.qty });
      }
      if (order.loyalty_earned) {
        db.increment('users', order.user_id, 'loyalty_points', -order.loyalty_earned);
        db.insert('loyalty_points', { id: 'lp' + uuidv4().slice(0, 8), user_id: order.user_id, points: -order.loyalty_earned, type: 'cancel', description: `Order ${order.id} cancelled`, created_at: new Date().toISOString() });
      }
      if (order.coupon_used) {
        const coupon = db.findAll('coupons').find(c => c.code === order.coupon_used);
        if (coupon && coupon.used > 0) db.updateById('coupons', coupon.id, { used: coupon.used - 1 });
      }
    }

    const updates = { status };
    if (status === 'delivered') updates.delivered_at = new Date().toISOString();
    if (status === 'picked_up') updates.picked_up_at = new Date().toISOString();
    const updated = db.updateById('orders', req.params.id, updates);

    const msgs = { preparing: 'Order ban raha hai 🍳', ready: 'Order ready hai, pickup hone wala hai 📦', picked_up: 'Order pick up ho gaya 📦', out_for_delivery: 'Order delivery ke liye nikla! 🏍️', delivered: 'Order deliver ho gaya! Rating do ⭐', cancelled: 'Order cancel ho gaya' };
    if (msgs[status]) {
      db.insert('notifications', { id: 'n' + uuidv4().slice(0, 8), user_id: order.user_id, title: msgs[status], body: `Order #${req.params.id}`, read: false, created_at: new Date().toISOString() });
    }

    if (status === 'delivered' && order.delivery_partner_id) {
      const dp = db.findOne('delivery_partners', { user_id: order.delivery_partner_id });
      if (dp) {
        db.increment('delivery_partners', dp.id, 'total_deliveries', 1);
        db.increment('delivery_partners', dp.id, 'total_earnings', DELIVERY_PARTNER_PAYOUT_RS);
        db.increment('users', order.delivery_partner_id, 'loyalty_points', DELIVERY_PARTNER_PAYOUT_RS);
      }
    }

    // Jab shop owner 'ready' status set kare toh delivery partners ko notify karo
    // FIX: pehle ye 'preparing' pe fire hota tha — jabki us waqt order abhi
    // bana hi raha hota tha, pickup ke liye ready nahi hota tha. Ab 'ready' pe fire hoga.
    if (status === 'ready') {
      const allPartners = db.findAll('delivery_partners').filter(dp => dp.status === 'active');
      const orderShops = [...new Set((order.items||[]).map(i=>i.shop_id))];
      const shopNames = orderShops.map(sid=>{ const s=db.findById('shops',sid); return s?.name||'Shop'; }).join(', ');
      for (const dp of allPartners) {
        const dpBody = `Order #${order.id.slice(-6).toUpperCase()} ready for pickup — ${shopNames} — ₹${order.total}`;
        db.insert('notifications', { id: 'n' + uuidv4().slice(0, 8), user_id: dp.user_id, title: '📦 New Order Available!', body: dpBody, read: false, created_at: new Date().toISOString() });
        req.wsBroadcast(dp.user_id, { type: 'new_order', message: '📦 ' + dpBody, order_id: order.id });
        req.sendPush(dp.user_id, 'New Order Available! 📦', dpBody, 'new-order');
      }
    }

    // Real-time broadcast via WebSocket + Push Notification
    const statusLabels = {
      preparing: 'Order prepare ho raha hai 🍳',
      ready: 'Order pickup ke liye ready hai 📦',
      picked_up: 'Delivery partner ne pick up kar liya 📦',
      out_for_delivery: 'Order raste mein hai! 🏍️',
      delivered: 'Order deliver ho gaya! 🎉',
      cancelled: 'Order cancel ho gaya ❌'
    };
    const wsMsg = statusLabels[status] || ('Order status: ' + status);
    // Customer ko push
    req.wsBroadcast(order.user_id, { type: 'status_update', message: wsMsg, status, order_id: order.id });
    // Shop owners ko push
    const shopIds = [...new Set((order.items||[]).map(i => i.shop_id))];
    db.findAll('shops').filter(s => shopIds.includes(s.id)).forEach(s => {
      req.wsBroadcast(s.owner_id, { type: 'status_update', message: 'Order #' + order.id.slice(-6).toUpperCase() + ': ' + wsMsg, status, order_id: order.id });
    });
    // Delivery partner ko push
    if (order.delivery_partner_id) {
      req.wsBroadcast(order.delivery_partner_id, { type: 'status_update', message: wsMsg, status, order_id: order.id });
    }
    // Mobile push — sabko
    req.sendPush(order.user_id, 'Order Update 📦', wsMsg, 'status-' + status);
    db.findAll('shops').filter(s => shopIds.includes(s.id)).forEach(s => req.sendPush(s.owner_id, 'Order Update', 'Order #' + order.id.slice(-6).toUpperCase() + ': ' + wsMsg, 'status'));
    if (order.delivery_partner_id) req.sendPush(order.delivery_partner_id, 'Order Update', wsMsg, 'status');

    res.json({ success: true, order: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/orders/:id/track
router.get('/:id/track', auth, (req, res) => {
  const order = db.findById('orders', req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

  const statusFlow = ['confirmed', 'preparing', 'ready', 'picked_up', 'out_for_delivery', 'delivered'];
  const currentIdx = statusFlow.indexOf(order.status);
  const timeline = statusFlow.map((s, i) => ({
    status: s,
    label: { confirmed: 'Order Confirmed', preparing: 'Preparing', ready: 'Ready for Pickup', picked_up: 'Picked Up', out_for_delivery: 'Out for Delivery', delivered: 'Delivered' }[s],
    completed: i <= currentIdx, active: i === currentIdx,
    timestamp: i <= currentIdx ? new Date(Date.now() - (currentIdx - i) * 10 * 60000).toISOString() : null
  }));

  const partner = order.delivery_partner_id ? db.findById('users', order.delivery_partner_id) : null;
  const dp = order.delivery_partner_id ? db.findOne('delivery_partners', { user_id: order.delivery_partner_id }) : null;

  res.json({ success: true, order_id: order.id, status: order.status, timeline, estimated_delivery: order.estimated_delivery, delivery_partner: partner ? { name: partner.name, phone: partner.phone, rating: dp?.rating || 4.9, vehicle: dp?.vehicle, lat: dp?.lat || null, lng: dp?.lng || null } : null });
});

module.exports = router;
