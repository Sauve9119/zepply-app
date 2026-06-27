const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const db = require('../middleware/db');
const { auth, generateToken } = require('../middleware/auth');

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password, role = 'customer', referred_by } = req.body;

    if (!name || !email || !phone || !password) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    if (!['customer', 'shopowner', 'delivery'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Invalid role' });
    }

    // Check if user exists
    const existing = db.findOne('users', { email });
    if (existing) return res.status(409).json({ success: false, message: 'Email already registered' });

    const hashedPwd = await bcrypt.hash(password, 10);
    const userId = 'u' + uuidv4().slice(0, 8);
    const referralCode = 'NEAR' + Math.floor(1000 + Math.random() * 9000);

    const user = {
      id: userId,
      name,
      email,
      phone,
      password: hashedPwd,
      role,
      loyalty_points: 100, // welcome bonus
      tier: 'bronze',
      referral_code: referralCode,
      referred_by: referred_by || null,
      created_at: new Date().toISOString()
    };

    db.insert('users', user);

    // Handle referral reward
    if (referred_by) {
      const referrer = db.findOne('users', { referral_code: referred_by });
      if (referrer) {
        db.increment('users', referrer.id, 'loyalty_points', 200);
        db.insert('referrals', {
          id: 'ref' + uuidv4().slice(0, 8),
          referrer_id: referrer.id,
          referred_id: userId,
          reward: 200,
          created_at: new Date().toISOString()
        });
        db.insert('notifications', {
          id: 'n' + uuidv4().slice(0, 8),
          user_id: referrer.id,
          title: 'Referral Reward!',
          body: `${name} joined using your code. You earned 200 NearKoins!`,
          read: false,
          created_at: new Date().toISOString()
        });
      }
    }

    // Welcome notification
    db.insert('notifications', {
      id: 'n' + uuidv4().slice(0, 8),
      user_id: userId,
      title: 'Welcome to NearKart! 🎉',
      body: `Welcome ${name}! You've received 100 NearKoins as a welcome bonus.`,
      read: false,
      created_at: new Date().toISOString()
    });

    // Create delivery partner profile if role is delivery
    if (role === 'delivery') {
      db.insert('delivery_partners', {
        id: 'dp' + uuidv4().slice(0, 8),
        user_id: userId,
        status: 'active',
        rating: 0,
        total_deliveries: 0,
        total_earnings: 0,
        coins: 100,
        badge: 'bronze',
        created_at: new Date().toISOString()
      });
    }

    const token = generateToken(userId);
    const { password: _, ...userSafe } = user;
    res.status(201).json({ success: true, message: 'Registration successful', token, user: userSafe });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }

    const user = db.findOne('users', { email });
    if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const token = generateToken(user.id);
    const { password: _, ...userSafe } = user;
    res.json({ success: true, message: 'Login successful', token, user: userSafe });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', auth, (req, res) => {
  const { password: _, ...userSafe } = req.user;
  res.json({ success: true, user: userSafe });
});

// PUT /api/auth/profile
router.put('/profile', auth, async (req, res) => {
  try {
    const { name, phone, address } = req.body;
    const updates = {};
    if (name) updates.name = name;
    if (phone) updates.phone = phone;
    if (address) updates.address = address;
    const updated = db.updateById('users', req.user.id, updates);
    const { password: _, ...userSafe } = updated;
    res.json({ success: true, user: userSafe });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/auth/change-password
router.put('/change-password', auth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    const user = db.findById('users', req.user.id);
    const valid = await bcrypt.compare(current_password, user.password);
    if (!valid) return res.status(400).json({ success: false, message: 'Current password incorrect' });
    const hashed = await bcrypt.hash(new_password, 10);
    db.updateById('users', req.user.id, { password: hashed });
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
