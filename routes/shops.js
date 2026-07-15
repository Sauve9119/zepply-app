const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const db = require('../middleware/db');
const { auth, requireRole } = require('../middleware/auth');
const { markupPrice } = require('../middleware/pricing');

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
  // FIX: pehle shop ka raw price hi seedha customer ko dikhta/bikta tha — koi
  // platform commission track hi nahi hoti thi. Ab customer-facing browsing mein
  // commission-inclusive price dikhta hai (shop apna base price hi set karta hai).
  products = products.map(p => {
    const shop = db.findById('shops', p.shop_id);
    return { ...p, price: markupPrice(p.price), mrp: p.mrp ? markupPrice(p.mrp) : p.mrp, shop_name: shop ? shop.name : 'Unknown', shop_emoji: shop ? shop.emoji : '🏪' };
  });
  res.json({ success: true, products, total: products.length });
});

// GET /api/shops
router.get('/', (req, res) => {
  const { category, lat, lng, radius = 10, search } = req.query;
  let shops = db.findAll('shops');
  if (category) shops = shops.filter(s => s.category.toLowerCase() === category.toLowerCase());
  if (search) shops = shops.filter(s => s.name.toLowerCase().includes(search.toLowerCase()));
  shops = shops.map(s => {
    const prods = db.findAll('products').filter(p => p.shop_id === s.id && p.is_active === true);
    let distKm = null;
    // FIX: agar shop ka lat/lng missing (null/undefined/0) hai toh formula NaN de sakta hai
    // — ab sirf tabhi calculate karte hain jab dono valid numbers hon.
    if (lat && lng && typeof s.lat === 'number' && typeof s.lng === 'number' && s.lat !== 0 && s.lng !== 0) {
      const R = 6371, dLat = (s.lat - parseFloat(lat)) * Math.PI / 180, dLng = (s.lng - parseFloat(lng)) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 + Math.cos(parseFloat(lat)*Math.PI/180) * Math.cos(s.lat*Math.PI/180) * Math.sin(dLng/2)**2;
      distKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }
    return { ...s, product_count: prods.length, distance_km: distKm !== null ? distKm.toFixed(2) : null };
  });
  // FIX: pehle jis shop ka lat/lng missing tha wo radius filter ko poori tarah
  // bypass kar deta tha (chahe customer 1000km door ho) — Kanpur se koi bhi
  // Jaipur ki shop se order kar sakta tha. Ab agar customer location diya hai,
  // toh sirf verified-nearby shops hi dikhengi; coordinates-less shops ko
  // "unknown distance" maan ke hide kar dete hain jab tak unka location set na ho.
  if (lat && lng) shops = shops.filter(s => s.distance_km !== null && parseFloat(s.distance_km) <= parseFloat(radius));
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
  // FIX: pehle req.body seedha updateById mein pass hota tha — koi bhi field
  // (owner_id, rating, id, total_reviews) mass-assign kar sakta tha. Ab sirf
  // shop owner ko jo fields edit karne chahiye wahi whitelist hain.
  const ALLOWED = ['name', 'category', 'description', 'emoji', 'address', 'lat', 'lng', 'min_order', 'delivery_charge', 'gst', 'delivery_time', 'is_open'];
  const updates = {};
  for (const key of ALLOWED) if (key in req.body) updates[key] = req.body[key];
  const updated = db.updateById('shops', req.params.id, updates);
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

// GET /api/shops/:shopId/products — customer-facing (commission-inclusive prices)
router.get('/:shopId/products', (req, res) => {
  const { category, search, on_sale } = req.query;
  let products = db.findAll('products').filter(p => p.shop_id === req.params.shopId && p.is_active === true);
  if (category) products = products.filter(p => p.category.toLowerCase() === category.toLowerCase());
  if (search) products = products.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));
  if (on_sale === 'true') products = products.filter(p => p.discount > 0);
  products = products.map(p => ({ ...p, price: markupPrice(p.price), mrp: p.mrp ? markupPrice(p.mrp) : p.mrp }));
  res.json({ success: true, products, total: products.length });
});

// GET /api/shops/:shopId/products/mine — shop owner's own raw (base) prices for management
// FIX: shop owner ko apna hi entered price dikhna chahiye (jo unhone type kiya),
// commission-inclusive customer price nahi — warna edit form confusing lagta hai.
router.get('/:shopId/products/mine', auth, requireRole('shopowner'), (req, res) => {
  const shop = db.findById('shops', req.params.shopId);
  if (!shop || shop.owner_id !== req.user.id) return res.status(403).json({ success: false, message: 'Not authorized' });
  const products = db.findAll('products').filter(p => p.shop_id === req.params.shopId);
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
  const product = db.findById('products', req.params.productId);
  // FIX: pehle sirf shop ownership check hoti thi, product actually us shop ka
  // hai ya nahi ye kabhi verify nahi hota tha — koi bhi shop owner kisi doosri
  // shop ka product edit/hide kar sakta tha agar productId pata ho (IDOR bug).
  if (!product || product.shop_id !== req.params.shopId) return res.status(404).json({ success: false, message: 'Product not found in this shop' });
  const ALLOWED = ['name', 'category', 'unit', 'price', 'mrp', 'emoji', 'discount', 'stock', 'is_active'];
  const updates = {};
  for (const key of ALLOWED) if (key in req.body) updates[key] = req.body[key];
  const updated = db.updateById('products', req.params.productId, updates);
  res.json({ success: true, product: updated });
});

// DELETE /api/shops/:shopId/products/:productId
router.delete('/:shopId/products/:productId', auth, requireRole('shopowner'), (req, res) => {
  const shop = db.findById('shops', req.params.shopId);
  if (!shop || shop.owner_id !== req.user.id) return res.status(403).json({ success: false, message: 'Not authorized' });
  const product = db.findById('products', req.params.productId);
  if (!product || product.shop_id !== req.params.shopId) return res.status(404).json({ success: false, message: 'Product not found in this shop' });
  db.updateById('products', req.params.productId, { is_active: false });
  res.json({ success: true, message: 'Product hidden from listing' });
});

module.exports = router;
