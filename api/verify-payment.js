import crypto from "crypto";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const PACKAGE_PRICES = {
  "Lead Generation": 460,
  "Commission Skill": 400,
  "Data Entry": 488,
  "Video Editing": 500,
  "Freelancing": 350,
  "Content Creation": 300
};

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function directRateForLevel(level) {
  if (level >= 51) return 0.50;
  if (level >= 31) return 0.48;
  if (level >= 26) return 0.45;
  if (level >= 16) return 0.43;
  if (level >= 11) return 0.40;
  if (level >= 9) return 0.35;
  if (level >= 5) return 0.30;
  return 0.20;
}

function generationRate(generation) {
  if (generation === 2) return 0.15;
  if (generation === 3) return 0.05;
  if (generation === 4) return 0.03;
  if (generation === 5) return 0.02;
  return 0;
}

function getFirebaseAdmin() {
  if (getApps().length) return getApps()[0];
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing");
  return initializeApp({ credential: cert(JSON.parse(raw)) });
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    getFirebaseAdmin();
    const db = getFirestore();

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, error: "Login required" });
    }

    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(authHeader.slice(7));
    } catch {
      return res.status(401).json({
        success: false,
        error: "Invalid or expired login session"
      });
    }

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        error: "Missing payment details"
      });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET;
    const keyId = process.env.RAZORPAY_KEY_ID;
    if (!secret || !keyId) {
      return res.status(500).json({
        success: false,
        error: "Razorpay environment variables missing"
      });
    }

    const expected = crypto
      .createHmac("sha256", secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    const a = Buffer.from(razorpay_signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(400).json({
        success: false,
        error: "Payment verification failed"
      });
    }

    const auth = Buffer.from(`${keyId}:${secret}`).toString("base64");

    const orderResponse = await fetch(
      `https://api.razorpay.com/v1/orders/${razorpay_order_id}`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    const order = await orderResponse.json();

    if (!orderResponse.ok) {
      return res.status(400).json({
        success: false,
        error: order?.error?.description || "Unable to verify Razorpay order"
      });
    }

    if (order.notes?.uid && order.notes.uid !== decoded.uid) {
      return res.status(403).json({
        success: false,
        error: "Payment does not belong to this account"
      });
    }

    const packageName = order.notes?.packageName;
    const packagePrice = PACKAGE_PRICES[packageName];
    if (!packagePrice) {
      return res.status(400).json({
        success: false,
        error: "Invalid package"
      });
    }

    if (Number(order.amount) !== Math.round(packagePrice * 100)) {
      return res.status(400).json({
        success: false,
        error: "Payment amount does not match package price"
      });
    }

    const paymentResponse = await fetch(
      `https://api.razorpay.com/v1/payments/${razorpay_payment_id}`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    const payment = await paymentResponse.json();

    if (!paymentResponse.ok) {
      return res.status(400).json({
        success: false,
        error: payment?.error?.description || "Unable to verify payment"
      });
    }

    if (payment.order_id !== razorpay_order_id) {
      return res.status(400).json({
        success: false,
        error: "Payment and order do not match"
      });
    }

    if (payment.status !== "captured") {
      return res.status(400).json({
        success: false,
        error: "Payment is not captured"
      });
    }

    const paymentRef = db.collection("payments").doc(razorpay_payment_id);
    const existing = await paymentRef.get();
    if (existing.exists && existing.data()?.commissionProcessed === true) {
      return res.status(200).json({
        success: true,
        alreadyProcessed: true,
        paymentId: razorpay_payment_id,
        orderId: razorpay_order_id
      });
    }

    const buyerRef = db.collection("users").doc(decoded.uid);
    const buyerSnap = await buyerRef.get();
    if (!buyerSnap.exists) {
      return res.status(404).json({
        success: false,
        error: "Buyer account not found"
      });
    }

    const buyer = buyerSnap.data() || {};
    const upline = [];
    const visited = new Set();
    let referral = buyer.referral || "";

    for (let generation = 1; generation <= 5; generation++) {
      if (!referral || referral === "Direct" || visited.has(referral)) break;
      visited.add(referral);

      const q = await db
        .collection("users")
        .where("userID", "==", referral)
        .limit(1)
        .get();

      if (q.empty) break;

      const refDoc = q.docs[0];
      const refData = refDoc.data() || {};
      upline.push({
        uid: refDoc.id,
        userID: refData.userID || "",
        generation
      });
      referral = refData.referral || "";
    }

    const commissions = [];

    if (upline.length) {
      const direct = upline[0];
      const directSnap = await db.collection("users").doc(direct.uid).get();
      const directData = directSnap.data() || {};
      const oldCount = Number(directData.directReferralCount || 0);
      const newCount = Math.min(oldCount + 1, 60);
      const rate = directRateForLevel(newCount);

      commissions.push({
        uid: direct.uid,
        userID: direct.userID,
        generation: 1,
        level: newCount,
        rate,
        amount: Math.round(packagePrice * rate * 100) / 100
      });
    }

    for (const person of upline.slice(1)) {
      const rate = generationRate(person.generation);
      if (!rate) continue;
      commissions.push({
        uid: person.uid,
        userID: person.userID,
        generation: person.generation,
        rate,
        amount: Math.round(packagePrice * rate * 100) / 100
      });
    }

    const totalCommission = commissions.reduce((s, x) => s + x.amount, 0);
    const idwpAmount = Math.round((packagePrice - totalCommission) * 100) / 100;

    await db.runTransaction(async transaction => {
      const freshPayment = await transaction.get(paymentRef);
      if (freshPayment.exists &&
          freshPayment.data()?.commissionProcessed === true) return;

      const freshBuyer = await transaction.get(buyerRef);
      if (!freshBuyer.exists) throw new Error("Buyer account not found");

      transaction.set(
        buyerRef,
        {
          package: packageName,
          packagePrice,
          packageActive: true,
          packagePaymentId: razorpay_payment_id,
          packageActivatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      if (upline.length) {
        const direct = upline[0];
        const directRef = db.collection("users").doc(direct.uid);
        const directSnap = await transaction.get(directRef);
        const directData = directSnap.data() || {};
        const newCount = Math.min(
          Number(directData.directReferralCount || 0) + 1,
          60
        );

        transaction.set(
          directRef,
          {
            directReferralCount: newCount,
            level: newCount,
            referralCommissionRate: directRateForLevel(newCount),
            freePackageEligible: newCount >= 8
          },
          { merge: true }
        );
      }

      for (const item of commissions) {
        const referrerRef = db.collection("users").doc(item.uid);

        transaction.set(
          referrerRef,
          {
            referralEarnings: FieldValue.increment(item.amount),
            earnings: FieldValue.increment(item.amount)
          },
          { merge: true }
        );

        transaction.set(db.collection("commissionLedger").doc(), {
          uid: item.uid,
          userID: item.userID,
          buyerUid: decoded.uid,
          buyerUserID: buyer.userID || "",
          generation: item.generation,
          level: item.level || null,
          rate: item.rate,
          amount: item.amount,
          package: packageName,
          packagePrice,
          paymentId: razorpay_payment_id,
          orderId: razorpay_order_id,
          status: "credited",
          createdAt: FieldValue.serverTimestamp()
        });
      }

      transaction.set(
        paymentRef,
        {
          uid: decoded.uid,
          userID: buyer.userID || "",
          package: packageName,
          amount: packagePrice,
          paymentId: razorpay_payment_id,
          orderId: razorpay_order_id,
          status: "Paid",
          commissionProcessed: true,
          totalCommission,
          idwpAmount,
          commissions,
          processedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      transaction.set(db.collection("platformLedger").doc(), {
        type: "package_sale",
        package: packageName,
        amount: packagePrice,
        totalCommission,
        idwpAmount,
        paymentId: razorpay_payment_id,
        orderId: razorpay_order_id,
        createdAt: FieldValue.serverTimestamp()
      });
    });

    return res.status(200).json({
      success: true,
      message: "Payment verified and package activated successfully.",
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      package: packageName,
      amount: packagePrice,
      totalCommission,
      idwpAmount,
      commissions
    });
  } catch (error) {
    console.error("Verify payment error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Server error"
    });
  }
}
