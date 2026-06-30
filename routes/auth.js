const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const router = express.Router();
const db = require('../middleware/db');
const { auth } = require('../middleware/auth');

const SECRET = process.env.JWT_SECRET || 'zepply_secret_2024';
const token = id => jwt.sign({ userId: id }, SECRET, { expiresIn: '7d' });
const safe = u => { if (!u) return null; const c = { ...u }; delete c.password; delete c.otp; delete c.otp_expiry; return c; };
const uid = () => uuidv4().replace(/-/g, '').slice(0, 12);

// Email transporter — Gmail se
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS  // Gmail App Password
  }
});

const sendOTP = async (email, otp, subject, body) => {
  if (!process.env.GMAIL_USER) {
    console.log(`[DEV] OTP for ${email}: ${otp}`);
    return true;
  }
  try {
    await transporter.sendMail({
      from: `"Zepply App" <${process.env.GMAIL_USER}>`,
      to: email,
      subject,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto;padding:20px">
          <h2 style="color:#6C47FF">🛒 Zepply</h2>
          <p>${body}</p>
          <div style="background:#f4f4f4;padding:20px;border-radius:8px;text-align:center;margin:20px 0">
            <h1 style="letter-spacing:8px;color:#6C47FF;margin:0">${otp}</h1>
          </div>
          <p style="color:#888;font-size:12px">Ye OTP 10 minute mein expire ho jaayega. Kisi ke saath share mat karo.</p>
        </div>`
    });
    return true;
  } catch (e) {
    console.error('Email error:', e.message);
    return false;
  }
};

// POST /api/auth/send-otp — register ke liye OTP bhejo
router.post('/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'Email required' });

  // Check existing user
  if (db.findOne('users', { email }))
    return res.status(409).json({ success: false, message: 'Ye email pehle se registered hai. Login karo.' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

  // OTP store karo (pending_otps)
  const existing = db.findOne('pending_otps', { email });
  if (existing) db.deleteById('pending_otps', existing.id);
  db.insert('pending_otps', { id: 'otp' + uid(), email, otp, expiry, verified: false });

  // Response turant bhejo — email background mein bhejo (taaki button slow na lage)
  res.json({ success: true, message: `OTP bheja gaya ${email} pe. 10 minute mein expire hoga.` });
  sendOTP(email, otp, 'Zepply — Email Verify karo', 'Aapka Zepply registration OTP:');
});

// POST /api/auth/verify-otp — OTP verify karo
router.post('/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  const record = db.findOne('pending_otps', { email, otp });
  if (!record) return res.status(400).json({ success: false, message: 'Galat OTP hai' });
  if (new Date(record.expiry) < new Date()) return res.status(400).json({ success: false, message: 'OTP expire ho gaya. Dobara bhejvao.' });
  db.updateById('pending_otps', record.id, { verified: true });
  res.json({ success: true, message: 'Email verify ho gaya!' });
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password, role = 'customer', referred_by } = req.body;
    if (!name || !email || !phone || !password) return res.status(400).json({ success: false, message: 'Saari fields bharo' });
    if (!/^[6-9]\d{9}$/.test(phone)) return res.status(400).json({ success: false, message: 'Valid 10-digit mobile number daalo (jaise 9876543210)' });
    if (!['customer', 'shopowner', 'delivery'].includes(role)) return res.status(400).json({ success: false, message: 'Invalid role' });
    if (db.findOne('users', { email })) return res.status(409).json({ success: false, message: 'Email pehle se registered hai' });

    // OTP verify check
    const otpRecord = db.findOne('pending_otps', { email, verified: true });
    if (!otpRecord) return res.status(400).json({ success: false, message: 'Pehle email OTP verify karo' });

    const hashed = await bcrypt.hash(password, 10);
    const refCode = 'ZEP' + Math.floor(1000 + Math.random() * 9000);
    const newUser = {
      id: 'u' + uid(), name, email, phone,
      password: hashed, role,
      loyalty_points: 100, tier: 'bronze',
      referral_code: refCode,
      referred_by: referred_by || null,
      created_at: new Date().toISOString()
    };
    db.insert('users', newUser);

    // OTP record delete karo
    db.deleteById('pending_otps', otpRecord.id);

    // Referral bonus
    if (referred_by) {
      const referrer = db.findOne('users', { referral_code: referred_by });
      if (referrer) {
        db.increment('users', referrer.id, 'loyalty_points', 200);
        db.insert('referrals', { id: 'ref' + uid(), referrer_id: referrer.id, referred_id: newUser.id, reward: 200, created_at: new Date().toISOString() });
        db.insert('notifications', { id: 'n' + uid(), user_id: referrer.id, title: 'Referral Reward! 🎉', body: `${name} join kar gaya! +200 ZepCoins mile.`, read: false, created_at: new Date().toISOString() });
      }
    }

    // Delivery partner profile
    if (role === 'delivery') {
      db.insert('delivery_partners', { id: 'dp' + uid(), user_id: newUser.id, status: 'active', rating: 5.0, total_deliveries: 0, total_earnings: 0, coins: 100, badge: 'bronze', created_at: new Date().toISOString() });
    }

    // Shop owner — auto-create their shop so products can be added right away
    if (role === 'shopowner') {
      db.insert('shops', {
        id: 's' + uid(), owner_id: newUser.id,
        name: name + "'s Shop", category: 'Grocery', description: '', emoji: '🏪',
        address: 'Jodhpur, Rajasthan', lat: 26.298, lng: 73.018,
        rating: 0, total_reviews: 0, is_open: true, delivery_time: '20 min',
        min_order: 100, delivery_charge: 25, gst: '',
        created_at: new Date().toISOString()
      });
    }

    db.insert('notifications', { id: 'n' + uid(), user_id: newUser.id, title: 'Zepply mein aapka swagat hai! 🎉', body: `Namaste ${name}! 100 ZepCoins welcome bonus mila.`, read: false, created_at: new Date().toISOString() });

    res.status(201).json({ success: true, message: 'Registration successful!', token: token(newUser.id), user: safe(newUser) });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: 'Server error' }); }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email aur password dono chahiye' });
    const u = db.findOne('users', { email });
    if (!u) return res.status(401).json({ success: false, message: 'Email ya password galat hai' });
    const ok = await bcrypt.compare(password, u.password);
    if (!ok) return res.status(401).json({ success: false, message: 'Email ya password galat hai' });
    res.json({ success: true, message: 'Login successful', token: token(u.id), user: safe(u) });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// POST /api/auth/forgot-password — OTP bhejo
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'Email required' });
  const u = db.findOne('users', { email });
  if (!u) return res.status(404).json({ success: false, message: 'Ye email registered nahi hai' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const existing = db.findOne('reset_otps', { email });
  if (existing) db.deleteById('reset_otps', existing.id);
  db.insert('reset_otps', { id: 'rot' + uid(), email, otp, expiry });

  res.json({ success: true, message: `OTP bheja gaya ${email} pe` });
  sendOTP(email, otp, 'Zepply — Password Reset OTP', 'Aapka password reset OTP:');
});

// POST /api/auth/reset-password — OTP verify karke password badlo
router.post('/reset-password', async (req, res) => {
  const { email, otp, new_password } = req.body;
  if (!email || !otp || !new_password) return res.status(400).json({ success: false, message: 'Email, OTP aur new password required' });
  if (new_password.length < 6) return res.status(400).json({ success: false, message: 'Password kam se kam 6 characters ka hona chahiye' });

  const record = db.findOne('reset_otps', { email, otp });
  if (!record) return res.status(400).json({ success: false, message: 'Galat OTP' });
  if (new Date(record.expiry) < new Date()) return res.status(400).json({ success: false, message: 'OTP expire ho gaya' });

  const u = db.findOne('users', { email });
  if (!u) return res.status(404).json({ success: false, message: 'User nahi mila' });

  const hashed = await bcrypt.hash(new_password, 10);
  db.updateById('users', u.id, { password: hashed });
  db.deleteById('reset_otps', record.id);

  res.json({ success: true, message: 'Password badal gaya! Ab login karo.' });
});

// GET /api/auth/me
router.get('/me', auth, (req, res) => res.json({ success: true, user: safe(req.user) }));

// PUT /api/auth/profile
router.put('/profile', auth, (req, res) => {
  const { name, phone, address } = req.body;
  const up = {};
  if (name) up.name = name; if (phone) up.phone = phone; if (address) up.address = address;
  const updated = db.updateById('users', req.user.id, up);
  res.json({ success: true, user: safe(updated) });
});

// PUT /api/auth/change-password
router.put('/change-password', auth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ success: false, message: 'Dono passwords required hain' });
  if (new_password.length < 6) return res.status(400).json({ success: false, message: 'Password kam se kam 6 characters ka hona chahiye' });
  const u = db.findById('users', req.user.id);
  const ok = await bcrypt.compare(current_password, u.password);
  if (!ok) return res.status(400).json({ success: false, message: 'Purana password galat hai' });
  await db.updateById('users', req.user.id, { password: await bcrypt.hash(new_password, 10) });
  res.json({ success: true, message: 'Password badal gaya!' });
});

module.exports = router;
