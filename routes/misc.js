const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const db = require('../middleware/db');
const { auth, requireRole } = require('../middleware/auth');

router.get('/notifications', auth, (req, res) => {
  const notifs = db.find('notifications', { user_id: req.user.id }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ success: true, notifications: notifs, unread: notifs.filter(n => !n.read).length });
});
router.put('/notifications/:id/read', auth, (req, res) => { db.updateById('notifications', req.params.id, { read: true }); res.json({ success: true }); });
router.put('/notifications/mark-all-read', auth, (req, res) => { db.updateMany('notifications', { user_id: req.user.id }, { read: true }); res.json({ success: true }); });

router.post('/reviews', auth, (req, res) => {
  try {
    const { order_id, shop_id, rating, comment, tags = [], review_type = 'text' } = req.body;
    if (!order_id || !shop_id || !rating) return res.status(400).json({ success: false, message: 'order_id, shop_id aur rating required hai' });
    if (rating < 1 || rating > 5) return res.status(400).json({ success: false, message: 'Rating 1 se 5 ke beech honi chahiye' });

    // FIX: Check karo ki ye order is customer ka hai
    const order = db.findById('orders', order_id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.user_id !== req.user.id) return res.status(403).json({ success: false, message: 'Ye order aapka nahi hai' });
    if (order.status !== 'delivered') return res.status(400).json({ success: false, message: 'Sirf delivered orders ka review de sakte hain' });

    const existing = db.find('reviews', { order_id, user_id: req.user.id });
    if (existing.length) return res.status(409).json({ success: false, message: 'Is order ka review pehle de chuke hain' });

    const review = { id: 'rev' + uuidv4().slice(0, 8), user_id: req.user.id, order_id, shop_id, rating: parseInt(rating), comment: comment || '', tags, review_type, created_at: new Date().toISOString() };
    db.insert('reviews', review);

    const shopReviews = db.find('reviews', { shop_id });
    const avgRating = (shopReviews.reduce((s, r) => s + r.rating, 0) / shopReviews.length).toFixed(1);
    db.updateById('shops', shop_id, { rating: parseFloat(avgRating), total_reviews: shopReviews.length });

    const pts = { text: 25, photo: 50, video: 100 }[review_type] || 25;
    db.increment('users', req.user.id, 'loyalty_points', pts);
    db.insert('loyalty_points', { id: 'lp' + uuidv4().slice(0, 8), user_id: req.user.id, points: pts, type: 'review', description: `Review reward - ${review_type}`, created_at: new Date().toISOString() });

    res.status(201).json({ success: true, review, points_earned: pts, message: `Review submit hua! +${pts} ZepCoins 🌟` });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

router.get('/reviews/shop/:shopId', (req, res) => {
  const reviews = db.find('reviews', { shop_id: req.params.shopId }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map(r => { const user = db.findById('users', r.user_id); return { ...r, user_name: user?.name }; });
  res.json({ success: true, reviews, total: reviews.length });
});

router.get('/wishlist', auth, (req, res) => {
  const items = db.find('wishlist', { user_id: req.user.id }).map(w => { const product = db.findById('products', w.product_id); const shop = product ? db.findById('shops', product.shop_id) : null; return { ...w, product, shop_name: shop?.name }; }).filter(w => w.product);
  res.json({ success: true, wishlist: items, total: items.length });
});

router.post('/wishlist/:productId', auth, (req, res) => {
  const existing = db.findOne('wishlist', { user_id: req.user.id, product_id: req.params.productId });
  if (existing) { db.deleteById('wishlist', existing.id); return res.json({ success: true, action: 'removed', message: 'Wishlist se hataya' }); }
  db.insert('wishlist', { id: 'wl' + uuidv4().slice(0, 8), user_id: req.user.id, product_id: req.params.productId, created_at: new Date().toISOString() });
  res.json({ success: true, action: 'added', message: 'Wishlist mein add hua ❤️' });
});

router.get('/analytics/shop/:shopId', auth, requireRole('shopowner'), (req, res) => {
  const shop = db.findById('shops', req.params.shopId);
  if (!shop || shop.owner_id !== req.user.id) return res.status(403).json({ success: false, message: 'Not authorized' });
  const allOrders = db.findAll('orders');
  const shopOrders = allOrders.filter(o => o.items && o.items.some(i => i.shop_id === req.params.shopId));
  const deliveredOrders = shopOrders.filter(o => o.status === 'delivered');
  const totalRevenue = deliveredOrders.reduce((s, o) => s + (o.items || []).filter(i => i.shop_id === req.params.shopId).reduce((ss, i) => ss + i.price * i.qty, 0), 0);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - i); return d.toISOString().split('T')[0]; }).reverse();
  const revenueByDay = days.map(day => { const dayOrders = deliveredOrders.filter(o => o.delivered_at && o.delivered_at.startsWith(day)); return { date: day, revenue: dayOrders.reduce((s, o) => s + (o.total || 0), 0), orders: dayOrders.length }; });
  const productSales = {};
  deliveredOrders.forEach(o => { (o.items || []).filter(i => i.shop_id === req.params.shopId).forEach(i => { if (!productSales[i.product_id]) productSales[i.product_id] = { qty: 0, revenue: 0 }; productSales[i.product_id].qty += i.qty; productSales[i.product_id].revenue += i.price * i.qty; }); });
  const topProducts = Object.entries(productSales).sort(([, a], [, b]) => b.revenue - a.revenue).slice(0, 5).map(([pid, stats]) => { const p = db.findById('products', pid); return { name: p?.name, emoji: p?.emoji, ...stats }; });
  res.json({ success: true, analytics: { total_orders: shopOrders.length, delivered_orders: deliveredOrders.length, total_revenue: totalRevenue, avg_order_value: deliveredOrders.length ? Math.round(totalRevenue / deliveredOrders.length) : 0, rating: shop.rating, total_reviews: shop.total_reviews, revenue_by_day: revenueByDay, top_products: topProducts } });
});

router.get('/promotions', (req, res) => {
  const { shop_id } = req.query;
  let promos = db.findAll('promotions').filter(p => p.status === 'active');
  if (shop_id) promos = promos.filter(p => p.shop_id === shop_id);
  res.json({ success: true, promotions: promos });
});

router.post('/promotions', auth, requireRole('shopowner'), (req, res) => {
  const { shop_id, title, type, value, min_order, applicable_to, ends_at } = req.body;
  const shop = db.findById('shops', shop_id);
  if (!shop || shop.owner_id !== req.user.id) return res.status(403).json({ success: false, message: 'Not authorized' });
  const promo = { id: 'pr' + uuidv4().slice(0, 8), shop_id, title, type, value, min_order: min_order || 0, applicable_to: applicable_to || 'all', status: 'active', ends_at: ends_at || null, created_at: new Date().toISOString() };
  db.insert('promotions', promo);
  res.status(201).json({ success: true, promotion: promo });
});

router.get('/analytics/platform', (req, res) => {
  const users = db.findAll('users'), orders = db.findAll('orders'), shops = db.findAll('shops');
  const deliveredOrders = orders.filter(o => o.status === 'delivered');
  const totalRevenue = deliveredOrders.reduce((s, o) => s + (o.total || 0), 0);
  res.json({ success: true, stats: { total_users: users.filter(u => u.role === 'customer').length, total_shops: shops.length, total_orders: orders.length, delivered_orders: deliveredOrders.length, total_revenue: totalRevenue, avg_order_value: deliveredOrders.length ? Math.round(totalRevenue / deliveredOrders.length) : 0, active_delivery_partners: db.find('delivery_partners', { status: 'active' }).length } });
});

module.exports = router;
