const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const db = require('../middleware/db');
const { auth, requireRole } = require('../middleware/auth');

// ===== PRODUCTS (global browse - MUST be before /:id routes) =====
router.get('/all/products', (req, res) => {
  const { search, category, on_sale, shop_id } = req.query;
  let products = db.findAll('products').filter(p => p.is_active === true);
  if (shop_id) products = products.filter(p => p.shop_id === shop_id);
  if (category) products = products.filter(p => p.category && p.category.toLowerCase() === category.toLowerCase());
  if (search) products = products.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.category && p.category.toLowerCase().includes(search.toLowerCase()))
  );
  if (on_sale === 'true') products = products.filter(p => p.discount > 0);
  products = products.map(p => {
    const shop = db.findById('shops', p.shop_id);
    return { ...p, shop_name: shop ? shop.name : 'Unknown', shop_emoji: shop ? shop.emoji : '🏪' };
  });
  res.json({ success: true, products, total: products.length });
});

// GET /api/shops
router.get('/', (req, res) => {
  const { category, lat, lng, radius = 5, search } = req.query;
  let shops = db.findAll('shops');
  if (category) shops = shops.filter(s => s.category.toLowerCase() === category.toLowerCase());
  if (search) shops = shops.filter(s => s.name.toLowerCase().includes(search.toLowerCase()));
  shops = shops.map(s => {
    const prods = db.findAll('products').filter(p => p.shop_id === s.id && p.is_active === true);
    let distKm = null;
    if (lat && lng) {
      const R = 6371, dLat = (s.lat - parseFloat(lat)) * Math.PI / 180, dLng = (s.lng - parseFloat(lng)) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 + Math.cos(parseFloat(lat)*Math.PI/180) * Math.cos(s.lat*Math.PI/180) * Math.sin(dLng/2)**2;
      distKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }
    return { ...s, product_count: prods.length, distance_km: distKm ? distKm.toFixed(2) : null };
  });
  if (lat && lng) shops = shops.filter(s => !s.distance_km || parseFloat(s.distance_km) <= parseFloat(radius));
  res.json({ success: true, shops, total: shops.length });
});

// GET /api/shops/:id
router.get('/:id', (req, res) => {
  const shop = db.findById('shops', req.params.id);
  if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });
  const products = db.findAll('products').filter(p => p.shop_id === shop.id && p.is_active === true);
  const reviews = db.find('reviews', { shop_id: shop.id });
  res.json({ success: true, shop: { ...shop, products, reviews } });
});

// POST /api/shops
router.post('/', auth, requireRole('shopowner'), (req, res) => {
  try {
    const { name, category, description, emoji, address, lat, lng, gst, min_order, delivery_charge } = req.body;
    if (!name || !category || !address) return res.status(400).json({ success: false, message: 'name, category and address required' });
    const shop = {
      id: 's' + uuidv4().slice(0, 8), owner_id: req.user.id,
      name, category, description: description || '', emoji: emoji || '🏪',
      address, lat: lat || 0, lng: lng || 0, rating: 0, total_reviews: 0,
      is_open: true, delivery_time: '20 min', min_order: min_order || 100,
      delivery_charge: delivery_charge || 25, gst: gst || '',
      created_at: new Date().toISOString()
    };
    db.insert('shops', shop);
    res.status(201).json({ success: true, shop });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// PUT /api/shops/:id
router.put('/:id', auth, requireRole('shopowner'), (req, res) => {
  const shop = db.findById('shops', req.params.id);
  if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });
  if (shop.owner_id !== req.user.id) return res.status(403).json({ success: false, message: 'Not your shop' });
  const updated = db.updateById('shops', req.params.id, req.body);
  res.json({ success: true, shop: updated });
});

// PUT /api/shops/:id/toggle
router.put('/:id/toggle', auth, requireRole('shopowner'), (req, res) => {
  const shop = db.findById('shops', req.params.id);
  if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });
  if (shop.owner_id !== req.user.id) return res.status(403).json({ success: false, message: 'Not your shop' });
  const updated = db.updateById('shops', req.params.id, { is_open: !shop.is_open });
  res.json({ success: true, is_open: updated.is_open });
});

// GET /api/shops/:shopId/products
router.get('/:shopId/products', (req, res) => {
  const { category, search, on_sale } = req.query;
  let products = db.findAll('products').filter(p => p.shop_id === req.params.shopId && p.is_active === true);
  if (category) products = products.filter(p => p.category.toLowerCase() === category.toLowerCase());
  if (search) products = products.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));
  if (on_sale === 'true') products = products.filter(p => p.discount > 0);
  res.json({ success: true, products, total: products.length });
});

// POST /api/shops/:shopId/products
router.post('/:shopId/products', auth, requireRole('shopowner'), (req, res) => {
  try {
    const shop = db.findById('shops', req.params.shopId);
    if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });
    if (shop.owner_id !== req.user.id) return res.status(403).json({ success: false, message: 'Not your shop' });
    const { name, category, unit, price, mrp, emoji, discount, stock } = req.body;
    if (!name || !price) return res.status(400).json({ success: false, message: 'name and price required' });
    const product = {
      id: 'p' + uuidv4().slice(0, 8), shop_id: req.params.shopId,
      name, category: category || 'General', unit: unit || 'pc',
      price: parseFloat(price), mrp: parseFloat(mrp || price),
      emoji: emoji || '📦', discount: parseInt(discount || 0),
      stock: parseInt(stock || 0), is_active: true,
      created_at: new Date().toISOString()
    };
    db.insert('products', product);
    res.status(201).json({ success: true, product });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// PUT /api/shops/:shopId/products/:productId
router.put('/:shopId/products/:productId', auth, requireRole('shopowner'), (req, res) => {
  const shop = db.findById('shops', req.params.shopId);
  if (!shop || shop.owner_id !== req.user.id) return res.status(403).json({ success: false, message: 'Not authorized' });
  const updated = db.updateById('products', req.params.productId, req.body);
  if (!updated) return res.status(404).json({ success: false, message: 'Product not found' });
  res.json({ success: true, product: updated });
});

// DELETE /api/shops/:shopId/products/:productId
router.delete('/:shopId/products/:productId', auth, requireRole('shopowner'), (req, res) => {
  const shop = db.findById('shops', req.params.shopId);
  if (!shop || shop.owner_id !== req.user.id) return res.status(403).json({ success: false, message: 'Not authorized' });
  db.updateById('products', req.params.productId, { is_active: false });
  res.json({ success: true, message: 'Product hidden from listing' });
});

module.exports = router;
