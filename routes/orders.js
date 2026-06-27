const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const db = require('../middleware/db');
const { auth, requireRole } = require('../middleware/auth');

router.get('/', auth, (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  let orders;
  if (req.user.role === 'customer') {
    orders = db.find('orders', { user_id: req.user.id });
  } else if (req.user.role === 'delivery') {
    orders = db.find('orders', { delivery_partner_id: req.user.id });
  } else if (req.user.role === 'shopowner') {
    const myShops = db.find('shops', { owner_id: req.user.id }).map(s => s.id);
    orders = db.findAll('orders').filter(o => o.items && o.items.some(i => myShops.includes(i.shop_id)));
  } else { orders = []; }

  if (status) orders = orders.filter(o => o.status === status);
  orders = orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  orders = orders.map(o => {
    const user = db.findById('users', o.user_id);
    const items = (o.items || []).map(item => {
      const product = db.findById('products', item.product_id);
      const shop = db.findById('shops', item.shop_id);
      return { ...item, product_name: product?.name, product_emoji: product?.emoji, shop_name: shop?.name };
    });
    return { ...o, customer_name: user?.name, customer_phone: user?.phone, items };
  });
  const total = orders.length;
  const start = (parseInt(page) - 1) * parseInt(limit);
  res.json({ success: true, orders: orders.slice(start, start + parseInt(limit)), total, page: parseInt(page), pages: Math.ceil(total / limit) });
});

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

router.post('/', auth, requireRole('customer'), (req, res) => {
  try {
    const { items, address, coupon_code, payment_method = 'cod' } = req.body;
    if (!items || !items.length) return res.status(400).json({ success: false, message: 'Cart is empty' });
    if (!address) return res.status(400).json({ success: false, message: 'Delivery address required' });

    let subtotal = 0;
    const enrichedItems = [];
    for (const item of items) {
      const product = db.findById('products', item.product_id);
      if (!product || !product.is_active)
        return res.status(400).json({ success: false, message: `Product ${item.product_id} not available` });
      if (product.stock < item.qty)
        return res.status(400).json({ success: false, message: `${product.name} mein sirf ${product.stock} bacha hai` });
      const itemTotal = product.price * item.qty;
      subtotal += itemTotal;
      enrichedItems.push({ product_id: item.product_id, shop_id: product.shop_id, qty: item.qty, price: product.price, total: itemTotal });
    }

    const delivery_charge = subtotal >= 300 ? 0 : 25;
    let discount = 0, coupon_used = null;
    if (coupon_code) {
      const coupon = db.findAll('coupons').find(c => c.code === coupon_code && c.active);
      if (coupon) {
        if (subtotal < coupon.min_order)
          return res.status(400).json({ success: false, message: `Minimum order ₹${coupon.min_order} chahiye` });
        if (coupon.max_uses && (coupon.used || 0) >= coupon.max_uses)
          return res.status(400).json({ success: false, message: 'Coupon limit khatam ho gaya' });
        // FIX: ek user ek coupon ek baar hi use kar sakta hai
        const alreadyUsed = db.findAll('orders').some(o => o.coupon_used === coupon_code && o.user_id === req.user.id && o.status !== 'cancelled');
        if (alreadyUsed)
          return res.status(400).json({ success: false, message: 'Aap ye coupon pehle use kar chuke hain' });
        discount = coupon.type === 'flat' ? coupon.value : Math.floor(subtotal * coupon.value / 100);
        coupon_used = coupon_code;
        db.updateById('coupons', coupon.id, { used: (coupon.used || 0) + 1 });
      }
    }

    const total = subtotal + delivery_charge - discount;
    const loyalty_earned = Math.floor(total / 10);
    const orderId = 'ord' + uuidv4().slice(0, 8);

    // Delivery partner assign — active pehle, phir koi bhi verified partner
    let partners = db.find('delivery_partners', { status: 'active' });
    if (!partners.length) partners = db.findAll('delivery_partners').filter(p => !['suspended', 'rejected', 'pending_verification'].includes(p.status));
    const assigned_partner = partners.length ? partners[0].user_id : null;

    const order = {
      id: orderId, user_id: req.user.id, items: enrichedItems, address,
      status: 'confirmed', subtotal, delivery_charge, discount, coupon_used,
      total, loyalty_earned, payment_method,
      payment_status: payment_method === 'cod' ? 'pending' : 'awaiting_payment',
      delivery_partner_id: assigned_partner,
      estimated_delivery: '25-35 min',
      created_at: new Date().toISOString()
    };
    db.insert('orders', order);

    for (const item of enrichedItems) {
      const product = db.findById('products', item.product_id);
      db.updateById('products', item.product_id, { stock: product.stock - item.qty });
    }

    db.increment('users', req.user.id, 'loyalty_points', loyalty_earned);
    db.insert('loyalty_points', { id: 'lp' + uuidv4().slice(0, 8), user_id: req.user.id, points: loyalty_earned, type: 'earn', description: `Order ${orderId}`, created_at: new Date().toISOString() });

    const user = db.findById('users', req.user.id);
    const pts = user.loyalty_points || 0;
    const tier = pts >= 10000 ? 'platinum' : pts >= 3000 ? 'gold' : pts >= 1000 ? 'silver' : 'bronze';
    db.updateById('users', req.user.id, { tier });

    db.insert('notifications', { id: 'n' + uuidv4().slice(0, 8), user_id: req.user.id, title: 'Order Confirmed! 🎉', body: `Order #${orderId} confirm hua. +${loyalty_earned} ZepCoins mile!`, read: false, created_at: new Date().toISOString() });
    if (assigned_partner) {
      db.insert('notifications', { id: 'n' + uuidv4().slice(0, 8), user_id: assigned_partner, title: 'New Delivery Job! 📦', body: `Order #${orderId} pickup ke liye ready hai`, read: false, created_at: new Date().toISOString() });
    }

    res.status(201).json({ success: true, order, message: `Order place hua! +${loyalty_earned} ZepCoins mile 🌟` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/:id/status', auth, (req, res) => {
  try {
    const { status } = req.body;
    const VALID = ['confirmed', 'preparing', 'picked_up', 'out_for_delivery', 'delivered', 'cancelled'];
    if (!VALID.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });

    const order = db.findById('orders', req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (req.user.role === 'shopowner') {
      const myShops = db.find('shops', { owner_id: req.user.id }).map(s => s.id);
      if (!order.items || !order.items.some(i => myShops.includes(i.shop_id)))
        return res.status(403).json({ success: false, message: 'Access denied' });
    }
    if (req.user.role === 'customer' && status !== 'cancelled')
      return res.status(403).json({ success: false, message: 'Customer sirf cancel kar sakta hai' });

    // FIX: Cancel hone par stock wapas aur loyalty points bhi wapas
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

    const msgs = { preparing: 'Order ban raha hai 🍳', picked_up: 'Order pick up ho gaya 📦', out_for_delivery: 'Order delivery ke liye nikla! 🏍️', delivered: 'Order deliver ho gaya! Rating do ⭐', cancelled: 'Order cancel ho gaya' };
    if (msgs[status]) {
      db.insert('notifications', { id: 'n' + uuidv4().slice(0, 8), user_id: order.user_id, title: msgs[status], body: `Order #${req.params.id}`, read: false, created_at: new Date().toISOString() });
    }

    if (status === 'delivered' && order.delivery_partner_id) {
      const dp = db.findOne('delivery_partners', { user_id: order.delivery_partner_id });
      if (dp) {
        db.increment('delivery_partners', dp.id, 'total_deliveries', 1);
        db.increment('delivery_partners', dp.id, 'total_earnings', 55);
        db.increment('users', order.delivery_partner_id, 'loyalty_points', 55);
      }
    }

    res.json({ success: true, order: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/:id/track', auth, (req, res) => {
  const order = db.findById('orders', req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  if (req.user.role === 'customer' && order.user_id !== req.user.id)
    return res.status(403).json({ success: false, message: 'Access denied' });

  const statusFlow = ['confirmed', 'preparing', 'picked_up', 'out_for_delivery', 'delivered'];
  const currentIdx = statusFlow.indexOf(order.status);
  const timeline = statusFlow.map((s, i) => ({
    status: s, label: { confirmed: 'Order Confirmed', preparing: 'Preparing', picked_up: 'Picked Up', out_for_delivery: 'Out for Delivery', delivered: 'Delivered' }[s],
    completed: i <= currentIdx, active: i === currentIdx,
    timestamp: i <= currentIdx ? new Date(Date.now() - (currentIdx - i) * 10 * 60000).toISOString() : null
  }));

  const partner = order.delivery_partner_id ? db.findById('users', order.delivery_partner_id) : null;
  const dp = order.delivery_partner_id ? db.findOne('delivery_partners', { user_id: order.delivery_partner_id }) : null;
  res.json({ success: true, order_id: order.id, status: order.status, timeline, estimated_delivery: order.estimated_delivery, delivery_partner: partner ? { name: partner.name, phone: partner.phone, rating: dp?.rating || 4.9, vehicle: dp?.vehicle, lat: 26.297 + (Math.random() - 0.5) * 0.005, lng: 73.020 + (Math.random() - 0.5) * 0.005 } : null });
});

module.exports = router;
