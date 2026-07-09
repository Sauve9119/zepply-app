'use strict';
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');

const db = require('./middleware/db');
const webpush = require('web-push');

// VAPID keys — Railway Variables mein set karo
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || 'BIm6FHpx1saLQE3JKEEi0JXqGO7gbA6ZkzcianTaO5wQtueh2i-ZWdIRkN_f76m1QJaL4vuoeDaRPuEbAHlPu7o';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'qqUyqa6THbdt__l07coMlvk1jsFR9CNYGSOjyTANsmQ';
webpush.setVapidDetails('mailto:zepply@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);

// Push karo kisi bhi user ko
async function sendPushNotification(userId, title, body, tag) {
  try {
    const subs = db.findAll ? db.findAll('push_subscriptions').filter(s => s.user_id === userId) : [];
    for (const sub of subs) {
      try {
        await webpush.sendNotification(JSON.parse(sub.subscription), JSON.stringify({ title, body, tag: tag || 'zepply', url: '/' }));
      } catch (e) {
        // Agar subscription expire ho gayi toh hata do
        if (e.statusCode === 410) db.deleteById && db.deleteById('push_subscriptions', sub.id);
      }
    }
  } catch (e) { console.error('Push error:', e.message); }
}

const authRoutes = require('./routes/auth');
const shopsRoutes = require('./routes/shops');
const ordersRoutes = require('./routes/orders');
const loyaltyRoutes = require('./routes/loyalty');
const deliveryRoutes = require('./routes/delivery');
const miscRoutes = require('./routes/misc');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const PORT = process.env.PORT || 3000;

// MIDDLEWARE
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, _, next) => {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${req.method} ${req.path}`);
  next();
});

// wsBroadcast ko routes ke saath share karo via app.locals
// (routes ko server.js import nahi karna padega — circular dependency avoid)
app.use((req, _, next) => { req.wsBroadcast = wsBroadcast; req.sendPush = sendPushNotification; next(); });

// MOUNT ALL ROUTES (modular — these contain all current fixes)
app.use('/api/auth', authRoutes);
app.use('/api/shops', shopsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/loyalty', loyaltyRoutes);
app.use('/api/delivery', deliveryRoutes);
app.use('/api', miscRoutes);

// POST /api/push/subscribe — user apna push subscription save kare
app.post('/api/push/subscribe', (req, res) => {
  try {
    const { userId, subscription } = req.body;
    if (!userId || !subscription) return res.status(400).json({ success: false, message: 'userId and subscription required' });
    // Purani subscription hata do pehle
    const existing = db.findAll('push_subscriptions').filter(s => s.user_id === userId);
    existing.forEach(s => db.deleteById && db.deleteById('push_subscriptions', s.id));
    db.insert('push_subscriptions', { id: 'ps' + Date.now(), user_id: userId, subscription: JSON.stringify(subscription), created_at: new Date().toISOString() });
    res.json({ success: true, message: 'Push subscription saved' });
  } catch (e) { res.status(500).json({ success: false }); }
});

// GET /api/push/vapid-key — frontend ko public key do
app.get('/api/push/vapid-key', (_, res) => res.json({ success: true, publicKey: VAPID_PUBLIC }));

app.get('/api/health', (_, res) => res.json({
  status: 'ok', app: 'Zepply API', version: '2.1.0',
  timestamp: new Date().toISOString(), uptime: Math.floor(process.uptime()) + 's'
}));

app.get('/api', (_, res) => res.json({
  app: 'Zepply Hyperlocal Delivery API',
  version: '2.1.0',
  total_endpoints: 41,
  endpoints: {
    auth: ['POST /api/auth/send-otp', 'POST /api/auth/verify-otp', 'POST /api/auth/register', 'POST /api/auth/login', 'GET /api/auth/me', 'PUT /api/auth/profile', 'PUT /api/auth/change-password', 'POST /api/auth/forgot-password', 'POST /api/auth/reset-password'],
    shops: ['GET /api/shops', 'GET /api/shops/all/products', 'GET /api/shops/:id', 'POST /api/shops', 'PUT /api/shops/:id', 'PUT /api/shops/:id/toggle', 'GET /api/shops/:shopId/products', 'POST /api/shops/:shopId/products', 'PUT /api/shops/:shopId/products/:productId', 'DELETE /api/shops/:shopId/products/:productId'],
    orders: ['GET /api/orders', 'GET /api/orders/:id', 'POST /api/orders', 'POST /api/orders/:id/accept', 'PUT /api/orders/:id/status', 'GET /api/orders/:id/track'],
    loyalty: ['GET /api/loyalty/balance', 'POST /api/loyalty/redeem', 'POST /api/loyalty/spin', 'GET /api/loyalty/leaderboard', 'POST /api/loyalty/review-reward', 'GET /api/loyalty/challenges', 'GET /api/loyalty/referrals', 'POST /api/loyalty/apply-coupon'],
    delivery: ['GET /api/delivery/profile', 'PUT /api/delivery/profile', 'PUT /api/delivery/status', 'GET /api/delivery/active-orders', 'GET /api/delivery/route', 'GET /api/delivery/earnings', 'GET /api/delivery/stats/dashboard'],
    misc: ['GET /api/notifications', 'PUT /api/notifications/mark-all-read', 'GET /api/wishlist', 'POST /api/wishlist/:productId', 'POST /api/reviews', 'GET /api/reviews/shop/:shopId', 'GET /api/promotions', 'POST /api/promotions', 'PUT /api/promotions/:id/status', 'GET /api/analytics/shop/:shopId', 'GET /api/analytics/platform']
  }
}));

// Serve frontend for non-API routes
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const f = path.join(__dirname, 'public', 'index.html');
  fs.existsSync(f) ? res.sendFile(f) : res.redirect('/api');
});

app.use((_, res) => res.status(404).json({ success: false, message: 'Route not found' }));

// WEBSOCKET — live delivery partner location tracking
const wsClients = new Map();

function wsBroadcast(userId, data) {
  const ws = wsClients.get(userId);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

wss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://localhost');
  const userId = u.searchParams.get('userId');
  if (userId) wsClients.set(userId, ws);
  ws.send(JSON.stringify({ type: 'connected', message: 'Zepply realtime connected ✅' }));

  ws.on('message', msg => {
    try {
      const d = JSON.parse(msg);
      if (d.type === 'location_update' && d.userId) {
        const order = db.findOne('orders', { delivery_partner_id: d.userId, status: 'out_for_delivery' });
        if (order) wsBroadcast(order.user_id, { type: 'partner_location', lat: d.lat, lng: d.lng, order_id: order.id });
      }
    } catch (e) {}
  });

  ws.on('close', () => { if (userId) wsClients.delete(userId); });
});

// START
server.listen(PORT, () => {
  console.log('\n========================================');
  console.log('   Zepply API v2.1 - Started');
  console.log('========================================');
  console.log(`API -> http://localhost:${PORT}/api`);
  console.log(`WS  -> ws://localhost:${PORT}`);
  console.log('========================================\n');
});

module.exports = { app, wsBroadcast, sendPushNotification };
