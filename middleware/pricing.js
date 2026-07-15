// FIX: pehle pricing ke numbers (delivery charge, delivery partner payout,
// loyalty earn rate) alag-alag files mein hardcoded aur inconsistent the
// (kahin ₹25, kahin ₹30, kahin ₹55). Ab ek hi jagah se sab derive hota hai.
//
// Business model (jaisa bataya gaya):
//   Shop apna base price set karta hai (jo unhe milna chahiye, e.g. ₹100).
//   Platform us par ITEM_COMMISSION_PCT% commission jodta hai — customer ko
//   yehi (₹105) dikhta hai. Shop ko poore ₹100 hi milte hain, ₹5 platform ka.
//
// UPDATE: delivery charge ab FIX ₹30 nahi hai — Blinkit/Zomato jaisa
// distance-based slab model hai. Pehle DELIVERY_BASE_KM tak ek base charge
// hai, uske baad har extra km ka alag se charge lagta hai. Delivery partner
// ka payout bhi isi tarah distance ke hisaab se badhta hai — jitni door
// delivery utna zyada milega, chahe customer ko order free-delivery threshold
// ki wajah se kam/free dikhe (partner ko hamesha poora distance-based payout
// milta hai, farak platform absorb karta hai).
//
// Example (5km delivery, base 2km/₹20 + ₹8/km; partner ₹15 + ₹6/km):
//   extra = ceil(5-2) = 3km -> customer charge = 20 + 3*8 = ₹44
//   partner payout   = 15 + 3*6 = ₹33
//   ₹100 ka item -> customer ko ₹105 dikhega. + ₹44 delivery = ₹149 total.
//   Shop payout: ₹100. Delivery partner: ₹33. Platform: ₹5 (item) + ₹11 (delivery) = ₹16.

const ITEM_COMMISSION_PCT = 5;       // shop ke base price par platform commission

// Distance-based delivery pricing (Blinkit/Zepto jaisa slab model)
const DELIVERY_BASE_KM = 2;              // itne km tak base charge/payout mein covered
const DELIVERY_BASE_CHARGE_RS = 20;      // customer se base charge (pehle 2km ke liye)
const DELIVERY_PER_KM_RS = 8;            // base ke baad customer se har extra km ka charge
const DELIVERY_PARTNER_BASE_PAYOUT_RS = 15; // delivery partner ka base payout (pehle 2km)
const DELIVERY_PARTNER_PER_KM_RS = 6;       // partner ko base ke baad har extra km ka
const DEFAULT_DELIVERY_DISTANCE_KM = 3;  // jab shop/customer coords available na ho, tab fallback distance

const FREE_DELIVERY_THRESHOLD_RS = 500; // ispar customer se delivery charge nahi liya jaata, platform khud us charge ko absorb karta hai (partner ka payout phir bhi distance-based hi milta hai)

const ZEPCOIN_EARN_PCT = 5;          // order total ka kitna % cashback (coins ke roop mein) milta hai
const ZEPCOIN_TO_RUPEE = 100;        // 100 ZepCoins = ₹1

function markupPrice(basePrice) {
  return Math.round(basePrice * (1 + ITEM_COMMISSION_PCT / 100));
}

// Distance (km) ko billable "extra km" (base ke aage) mein convert karta hai.
// Missing/invalid distance ke liye ek sensible default use karte hain taaki
// partner ko kabhi ₹0 na mile aur customer ko kabhi galat se bahut kam charge na ho.
function billableExtraKm(distanceKm) {
  const d = (typeof distanceKm === 'number' && isFinite(distanceKm) && distanceKm > 0) ? distanceKm : DEFAULT_DELIVERY_DISTANCE_KM;
  return Math.max(0, Math.ceil(d - DELIVERY_BASE_KM));
}

// Customer se liya jaane wala delivery charge, distance ke hisaab se.
function calcDeliveryCharge(distanceKm) {
  return DELIVERY_BASE_CHARGE_RS + billableExtraKm(distanceKm) * DELIVERY_PER_KM_RS;
}

// Delivery partner ko milne wala payout, distance ke hisaab se (Blinkit/Zomato
// delivery partner jaisa per-km incentive) — order free-delivery ho ya na ho,
// partner ko yehi poora amount milta hai.
function calcPartnerPayout(distanceKm) {
  return DELIVERY_PARTNER_BASE_PAYOUT_RS + billableExtraKm(distanceKm) * DELIVERY_PARTNER_PER_KM_RS;
}

function coinsEarnedForTotal(totalRs) {
  // 5% cashback, coins mein express kiya gaya (100 coins = ₹1)
  return Math.floor(totalRs * (ZEPCOIN_EARN_PCT / 100) * ZEPCOIN_TO_RUPEE);
}

function coinsToRupees(coins) {
  return coins / ZEPCOIN_TO_RUPEE;
}

module.exports = {
  ITEM_COMMISSION_PCT, FREE_DELIVERY_THRESHOLD_RS,
  DELIVERY_BASE_KM, DELIVERY_BASE_CHARGE_RS, DELIVERY_PER_KM_RS,
  DELIVERY_PARTNER_BASE_PAYOUT_RS, DELIVERY_PARTNER_PER_KM_RS, DEFAULT_DELIVERY_DISTANCE_KM,
  ZEPCOIN_EARN_PCT, ZEPCOIN_TO_RUPEE,
  markupPrice, calcDeliveryCharge, calcPartnerPayout, coinsEarnedForTotal, coinsToRupees
};
