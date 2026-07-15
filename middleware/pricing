// FIX: pehle pricing ke numbers (delivery charge, delivery partner payout,
// loyalty earn rate) alag-alag files mein hardcoded aur inconsistent the
// (kahin ₹25, kahin ₹30, kahin ₹55). Ab ek hi jagah se sab derive hota hai.
//
// Business model (jaisa bataya gaya):
//   Shop apna base price set karta hai (jo unhe milna chahiye, e.g. ₹100).
//   Platform us par ITEM_COMMISSION_PCT% commission jodta hai — customer ko
//   yehi (₹105) dikhta hai. Shop ko poore ₹100 hi milte hain, ₹5 platform ka.
//   Delivery charge customer se DELIVERY_CHARGE_RS liya jaata hai, jisme se
//   DELIVERY_PARTNER_PAYOUT_RS delivery partner ko, baaki platform ko.
//
// Example: ₹100 ka item -> customer ko ₹105 dikhega. + ₹30 delivery = ₹135 total.
//   Shop payout: ₹100. Delivery partner: ₹20. Platform: ₹5 (item) + ₹10 (delivery) = ₹15.

const ITEM_COMMISSION_PCT = 5;       // shop ke base price par platform commission
const DELIVERY_CHARGE_RS = 30;       // customer se liya jaane wala delivery charge
const DELIVERY_PARTNER_PAYOUT_RS = 20; // delivery partner ko milta hai (₹30 mein se)
const FREE_DELIVERY_THRESHOLD_RS = 500; // ispar delivery free hai (customer ko), platform khud delivery cost absorb karta hai

const ZEPCOIN_EARN_PCT = 5;          // order total ka kitna % cashback (coins ke roop mein) milta hai
const ZEPCOIN_TO_RUPEE = 100;        // 100 ZepCoins = ₹1

function markupPrice(basePrice) {
  return Math.round(basePrice * (1 + ITEM_COMMISSION_PCT / 100));
}

function coinsEarnedForTotal(totalRs) {
  // 5% cashback, coins mein express kiya gaya (100 coins = ₹1)
  return Math.floor(totalRs * (ZEPCOIN_EARN_PCT / 100) * ZEPCOIN_TO_RUPEE);
}

function coinsToRupees(coins) {
  return coins / ZEPCOIN_TO_RUPEE;
}

module.exports = {
  ITEM_COMMISSION_PCT, DELIVERY_CHARGE_RS, DELIVERY_PARTNER_PAYOUT_RS, FREE_DELIVERY_THRESHOLD_RS,
  ZEPCOIN_EARN_PCT, ZEPCOIN_TO_RUPEE,
  markupPrice, coinsEarnedForTotal, coinsToRupees
};
