const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const db = require('../middleware/db');
const { auth } = require('../middleware/auth');

// GET /api/loyalty/balance
router.get('/balance', auth, (req, res) => {
  const user = db.findById('users', req.user.id);
  const history = db.find('loyalty_points', { user_id: req.user.id })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 20);

  const tiers = { bronze: 0, silver: 1000, gold: 3000, platinum: 10000 };
  const tierNames = Object.keys(tiers);
  const currentTierIdx = tierNames.indexOf(user.tier || 'bronze');
  const nextTier = tierNames[currentTierIdx + 1];
  const nextTierPts = nextTier ? tiers[nextTier] : null;

  res.json({
    success: true,
    points: user.loyalty_points || 0,
    tier: user.tier || 'bronze',
    next_tier: nextTier || null,
    points_to_next_tier: nextTierPts ? Math.max(0, nextTierPts - user.loyalty_points) : 0,
    history
  });
});

// POST /api/loyalty/redeem
router.post('/redeem', auth, (req, res) => {
  const { reward_type, points_cost } = req.body;
  const user = db.findById('users', req.user.id);

  if ((user.loyalty_points || 0) < points_cost) {
    return res.status(400).json({ success: false, message: 'Not enough NearKoins' });
  }

  const rewards = {
    discount_50: { cost: 500, description: '₹50 off coupon', coupon_value: 50 },
    free_delivery: { cost: 1000, description: 'Free delivery x5', coupon_value: 0 },
    discount_200: { cost: 1500, description: '₹200 off coupon', coupon_value: 200 },
    hardware_10pct: { cost: 250, description: '10% off Hardware', coupon_value: 0 },
    free_item: { cost: 750, description: 'Free item up to ₹50', coupon_value: 50 },
    scratch_card: { cost: 100, description: 'Scratch card', coupon_value: 0 }
  };

  const reward = rewards[reward_type];
  if (!reward) return res.status(400).json({ success: false, message: 'Invalid reward type' });
  if (reward.cost !== points_cost) return res.status(400).json({ success: false, message: 'Points mismatch' });

  db.increment('users', req.user.id, 'loyalty_points', -points_cost);
  db.insert('loyalty_points', {
    id: 'lp' + uuidv4().slice(0, 8),
    user_id: req.user.id,
    points: -points_cost,
    type: 'redeem',
    description: `Redeemed: ${reward.description}`,
    created_at: new Date().toISOString()
  });

  // Generate coupon if applicable
  let coupon = null;
  if (reward.coupon_value > 0) {
    const code = 'RWD' + Math.random().toString(36).slice(2, 8).toUpperCase();
    coupon = {
      code,
      type: 'flat',
      value: reward.coupon_value,
      min_order: 0,
      max_uses: 1,
      used: 0,
      active: true,
      user_id: req.user.id
    };
    const coupons = db.findAll('coupons') || [];
    const allData = { coupons: [...coupons, coupon] };
    // update via db
    db.insert('coupons', coupon);
  }

  res.json({ success: true, message: `Redeemed: ${reward.description}`, remaining_points: (user.loyalty_points || 0) - points_cost, coupon });
});

// POST /api/loyalty/spin
router.post('/spin', auth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const todaySpins = db.find('spin_history', { user_id: req.user.id })
    .filter(s => s.date === today);

  if (todaySpins.length >= 3) {
    return res.status(400).json({ success: false, message: 'No spins remaining today. Come back tomorrow!' });
  }

  const prizes = [
    { label: '50 Coins', type: 'coins', value: 50, probability: 30 },
    { label: '100 Coins', type: 'coins', value: 100, probability: 20 },
    { label: '200 Coins', type: 'coins', value: 200, probability: 10 },
    { label: '500 Coins', type: 'coins', value: 500, probability: 3 },
    { label: '₹25 Off Coupon', type: 'coupon', value: 25, probability: 15 },
    { label: '₹50 Off Coupon', type: 'coupon', value: 50, probability: 8 },
    { label: 'Free Delivery', type: 'free_delivery', value: 1, probability: 9 },
    { label: 'Better Luck!', type: 'none', value: 0, probability: 5 }
  ];

  // Weighted random selection
  const total = prizes.reduce((s, p) => s + p.probability, 0);
  let rand = Math.random() * total;
  let prize = prizes[prizes.length - 1];
  for (const p of prizes) {
    rand -= p.probability;
    if (rand <= 0) { prize = p; break; }
  }

  // Apply prize
  if (prize.type === 'coins') {
    db.increment('users', req.user.id, 'loyalty_points', prize.value);
    db.insert('loyalty_points', {
      id: 'lp' + uuidv4().slice(0, 8),
      user_id: req.user.id, points: prize.value, type: 'spin',
      description: `Spin & Win: ${prize.label}`,
      created_at: new Date().toISOString()
    });
  }

  db.insert('spin_history', {
    id: 'sp' + uuidv4().slice(0, 8),
    user_id: req.user.id,
    prize: prize.label,
    type: prize.type,
    value: prize.value,
    date: today,
    created_at: new Date().toISOString()
  });

  const spinsLeft = 3 - (todaySpins.length + 1);
  res.json({ success: true, prize, spins_remaining: spinsLeft, message: prize.type === 'none' ? 'Better luck next time!' : `🎉 You won: ${prize.label}!` });
});

// GET /api/loyalty/leaderboard
router.get('/leaderboard', (req, res) => {
  const users = db.findAll('users')
    .filter(u => u.role === 'customer')
    .sort((a, b) => (b.loyalty_points || 0) - (a.loyalty_points || 0))
    .slice(0, 20)
    .map((u, i) => ({
      rank: i + 1,
      name: u.name,
      points: u.loyalty_points || 0,
      tier: u.tier || 'bronze',
      referral_code: u.referral_code
    }));
  res.json({ success: true, leaderboard: users });
});

// POST /api/loyalty/review-reward — earn coins for reviewing
router.post('/review-reward', auth, (req, res) => {
  const { order_id, review_type } = req.body;
  const rewards = { text: 25, photo: 50, video: 100 };
  const pts = rewards[review_type] || 25;
  db.increment('users', req.user.id, 'loyalty_points', pts);
  db.insert('loyalty_points', {
    id: 'lp' + uuidv4().slice(0, 8),
    user_id: req.user.id, points: pts, type: 'review',
    description: `${review_type} review reward`,
    created_at: new Date().toISOString()
  });
  res.json({ success: true, points_earned: pts, message: `+${pts} NearKoins for your review!` });
});

// GET /api/loyalty/challenges
router.get('/challenges', auth, (req, res) => {
  const challenges = db.findAll('challenges');
  // In production, track per-user progress in a user_challenges collection
  const enriched = challenges.map(c => ({
    ...c,
    progress: Math.floor(Math.random() * c.target), // mock for demo
    completed: false
  }));
  res.json({ success: true, challenges: enriched });
});

// GET /api/loyalty/referrals
router.get('/referrals', auth, (req, res) => {
  const referrals = db.find('referrals', { referrer_id: req.user.id });
  const enriched = referrals.map(r => {
    const referred = db.findById('users', r.referred_id);
    return { ...r, referred_name: referred?.name, referred_email: referred?.email };
  });
  res.json({ success: true, referrals: enriched, total_earned: enriched.length * 200, count: enriched.length });
});

// POST /api/loyalty/apply-coupon
router.post('/apply-coupon', auth, (req, res) => {
  const { code, order_total } = req.body;
  const coupons = db.findAll('coupons');
  const coupon = coupons.find(c => c.code === code && c.active);
  if (!coupon) return res.status(404).json({ success: false, message: 'Invalid coupon code' });
  if (order_total < coupon.min_order) return res.status(400).json({ success: false, message: `Minimum order ₹${coupon.min_order} required` });
  const discount = coupon.type === 'flat' ? coupon.value : Math.floor(order_total * coupon.value / 100);
  res.json({ success: true, coupon: { code, type: coupon.type, value: coupon.value, discount }, message: `Coupon applied! Saving ₹${discount}` });
});

module.exports = router;
