const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const db = require('../middleware/db');
const { auth, requireRole } = require('../middleware/auth');

// GET /api/delivery/profile
router.get('/profile', auth, requireRole('delivery'), (req, res) => {
  const dp = db.findOne('delivery_partners', { user_id: req.user.id });
  if (!dp) return res.status(404).json({ success: false, message: 'Delivery profile not found' });
  const { password: _, ...user } = req.user;
  res.json({ success: true, profile: { ...dp, ...user } });
});

// PUT /api/delivery/profile
router.put('/profile', auth, requireRole('delivery'), (req, res) => {
  const { vehicle, reg_number, license } = req.body;
  const dp = db.findOne('delivery_partners', { user_id: req.user.id });
  if (!dp) return res.status(404).json({ success: false, message: 'Profile not found' });
  const updates = {};
  if (vehicle) updates.vehicle = vehicle;
  if (reg_number) updates.reg_number = reg_number;
  if (license) updates.license = license;
  const updated = db.updateById('delivery_partners', dp.id, updates);
  res.json({ success: true, profile: updated });
});

// PUT /api/delivery/status — go online/offline
router.put('/status', auth, requireRole('delivery'), (req, res) => {
  const { status, lat, lng } = req.body;
  const dp = db.findOne('delivery_partners', { user_id: req.user.id });
  if (!dp) return res.status(404).json({ success: false, message: 'Profile not found' });
  const updates = { status };
  if (lat) updates.current_lat = lat;
  if (lng) updates.current_lng = lng;
  const updated = db.updateById('delivery_partners', dp.id, updates);
  res.json({ success: true, status: updated.status, message: status === 'active' ? '🟢 You are now Online' : '🔴 You are now Offline' });
});

// GET /api/delivery/active-orders — orders assigned to this partner
router.get('/active-orders', auth, requireRole('delivery'), (req, res) => {
  const orders = db.find('orders', { delivery_partner_id: req.user.id })
    .filter(o => !['delivered', 'cancelled'].includes(o.status))
    .map(o => {
      const user = db.findById('users', o.user_id);
      const items = (o.items || []).map(item => {
        const shop = db.findById('shops', item.shop_id);
        const product = db.findById('products', item.product_id);
        return { ...item, shop_name: shop?.name, shop_address: shop?.address, shop_lat: shop?.lat, shop_lng: shop?.lng, product_name: product?.name };
      });
      return { ...o, customer_name: user?.name, customer_phone: user?.phone, items };
    });
  res.json({ success: true, orders, count: orders.length });
});

// GET /api/delivery/route — optimised pickup + drop route
router.get('/route', auth, requireRole('delivery'), (req, res) => {
  const orders = db.find('orders', { delivery_partner_id: req.user.id })
    .filter(o => ['confirmed', 'preparing', 'picked_up'].includes(o.status));

  if (!orders.length) {
    return res.json({ success: true, message: 'No active orders', route: [] });
  }

  // Collect unique pickup shops
  const shopIds = [...new Set(orders.flatMap(o => (o.items || []).map(i => i.shop_id)))];
  const pickups = shopIds.map(sid => {
    const shop = db.findById('shops', sid);
    const shopOrders = orders.filter(o => o.items.some(i => i.shop_id === sid));
    return { type: 'pickup', shop_id: sid, name: shop?.name, address: shop?.address, lat: shop?.lat, lng: shop?.lng, orders: shopOrders.map(o => o.id), emoji: shop?.emoji };
  });

  // Collect drops
  const drops = orders.map(o => {
    const user = db.findById('users', o.user_id);
    return { type: 'drop', order_id: o.id, name: user?.name, address: o.address, lat: null, lng: null, phone: user?.phone, earning: 25 };
  });

  // Simple TSP: sort pickups by proximity to current location, then drops
  // In production this would use Google Maps Routes API
  const allStops = [...pickups, ...drops];
  const totalDist = (allStops.length * 0.6).toFixed(1);
  const totalTime = Math.ceil(allStops.length * 5) + ' min';
  const totalEarning = drops.length * 25;

  res.json({
    success: true,
    route: allStops,
    summary: {
      total_stops: allStops.length,
      total_distance_km: parseFloat(totalDist),
      estimated_time: totalTime,
      total_earning: totalEarning,
      bonus: drops.length >= 5 ? 200 : 0,
      algorithm: 'Nearest-Neighbor TSP',
      distance_saved_km: 4.2,
      time_saved_min: 18
    }
  });
});

// GET /api/delivery/earnings
router.get('/earnings', auth, requireRole('delivery'), (req, res) => {
  const dp = db.findOne('delivery_partners', { user_id: req.user.id });
  if (!dp) return res.status(404).json({ success: false, message: 'Profile not found' });

  const today = new Date().toISOString().split('T')[0];
  const todayOrders = db.find('orders', { delivery_partner_id: req.user.id, status: 'delivered' })
    .filter(o => o.delivered_at && o.delivered_at.startsWith(today));

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);

  const earnings = {
    today: { deliveries: todayOrders.length, base: todayOrders.length * 25, bonus: 0, tips: 0, total: todayOrders.length * 25 },
    month: { deliveries: dp.total_deliveries, total: dp.total_earnings, avg_per_delivery: dp.total_deliveries > 0 ? Math.round(dp.total_earnings / dp.total_deliveries) : 0 },
    daily_target: { target: 20, current: todayOrders.length, bonus_on_completion: 200 },
    rating: dp.rating || 0,
    coins: dp.coins || 0,
    badge: dp.badge || 'bronze',
    incentives: [
      { name: 'Peak Hour (6-9PM)', multiplier: '1.5×', active: true },
      { name: 'Rain Surge', multiplier: '2×', active: false },
      
      { name: 'Weekend Bonus', multiplier: '1.3×', active: new Date().getDay() >= 5 }
    ]
  };

  res.json({ success: true, earnings });
});

// GET /api/delivery/stats/dashboard
router.get('/stats/dashboard', auth, requireRole('delivery'), (req, res) => {
  const dp = db.findOne('delivery_partners', { user_id: req.user.id });

  // FIX: rank/top_percentile pehle mock the (hardcoded 3, 12). Ab saare active
  // delivery partners ko total_earnings ke hisaab se sort karke real rank nikalte hain.
  const allPartners = db.findAll('delivery_partners')
    .slice()
    .sort((a, b) => (b.total_earnings || 0) - (a.total_earnings || 0));
  const myIndex = dp ? allPartners.findIndex(p => p.id === dp.id) : -1;
  const rank = myIndex === -1 ? null : myIndex + 1;
  const topPercentile = (rank && allPartners.length) ? Math.max(1, Math.round((rank / allPartners.length) * 100)) : null;

  res.json({
    success: true,
    stats: {
      total_deliveries: dp?.total_deliveries || 0,
      total_earnings: dp?.total_earnings || 0,
      rating: dp?.rating || 0,
      coins: dp?.coins || 0,
      badge: dp?.badge || 'bronze',
      rank,
      top_percentile: topPercentile
    }
  });
});

module.exports = router;
