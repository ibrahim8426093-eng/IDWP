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

// Direct commission based on verified direct referrals
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

// Upline commission
function generationRate(generation) {
  if (generation === 2) return 0.15;
  if (generation === 3) return 0.05;
  if (generation === 4) return 0.03;
  if (generation === 5) return 0.02;
  return 0;
}

function getFirebaseAdmin() {
  if (getApps().length) {
    return getApps()[0];
  }

  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  );

  return initializeApp({
    credential: cert(serviceAccount)
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    getFirebaseAdmin();

    const db = getFirestore();

    // --------------------------------
    // 1. Check Firebase Login
    // --------------------------------
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Login required"
      });
    }

    const idToken = authHeader.substring(7);

    let decodedToken;

    try {
      decodedToken = await getAuth().verifyIdToken(idToken);
    } catch (error) {
      return res.status(401).json({
        success: false,
        error: "Invalid or expired login session"
      });
    }

    const buyerUid = decodedToken.uid;

    // --------------------------------
    // 2. Payment Details
    // --------------------------------
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body || {};

    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
      return res.status(400).json({
        success: false,
        error: "Missing payment details"
      });
    }

    // --------------------------------
    // 3. Razorpay Secret
    // --------------------------------
    const secret = process.env.RAZORPAY_KEY_SECRET;

    if (!secret) {
      return res.status(500).json({
        success: false,
        error: "Razorpay secret is not configured"
      });
    }

    // --------------------------------
    // 4. Verify Razorpay Signature
    // --------------------------------
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(
        `${razorpay_order_id}|${razorpay_payment_id}`
      )
      .digest("hex");

    const signatureBuffer = Buffer.from(razorpay_signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(
        signatureBuffer,
        expectedBuffer
      )
    ) {
      return res.status(400).json({
        success: false,
        error: "Payment verification failed"
      });
    }

    // --------------------------------
    // 5. Razorpay API Check
    // --------------------------------
    const keyId = process.env.RAZORPAY_KEY_ID;

    if (!keyId) {
      return res.status(500).json({
        success: false,
        error: "Razorpay key ID is not configured"
      });
    }

    const razorpayAuth = Buffer
      .from(`${keyId}:${secret}`)
      .toString("base64");

    const orderResponse = await fetch(
      `https://api.razorpay.com/v1/orders/${razorpay_order_id}`,
      {
        method: "GET",
        headers: {
          "Authorization": `Basic ${razorpayAuth}`
        }
      }
    );

    const orderData = await orderResponse.json();

    if (!orderResponse.ok) {
      return res.status(400).json({
        success: false,
        error:
          orderData.error?.description ||
          "Unable to verify Razorpay order"
      });
    }

    // --------------------------------
    // 6. Verify Order Belongs To Buyer
    // --------------------------------
    if (
      orderData.notes?.uid &&
      orderData.notes.uid !== buyerUid
    ) {
      return res.status(403).json({
        success: false,
        error: "Payment does not belong to this account"
      });
    }

    const packageName = orderData.notes?.packageName;

    if (!packageName || !PACKAGE_PRICES[packageName]) {
      return res.status(400).json({
        success: false,
        error: "Invalid package"
      });
    }

    const expectedAmount = Math.round(
      PACKAGE_PRICES[packageName] * 100
    );

    if (Number(orderData.amount) !== expectedAmount) {
      return res.status(400).json({
        success: false,
        error: "Payment amount does not match package price"
      });
    }

    // --------------------------------
    // 7. Check Payment
    // --------------------------------
    const paymentResponse = await fetch(
      `https://api.razorpay.com/v1/payments/${razorpay_payment_id}`,
      {
        method: "GET",
        headers: {
          "Authorization": `Basic ${razorpayAuth}`
        }
      }
    );

    const paymentData = await paymentResponse.json();

    if (!paymentResponse.ok) {
      return res.status(400).json({
        success: false,
        error:
          paymentData.error?.description ||
          "Unable to verify payment"
      });
    }

    if (paymentData.order_id !== razorpay_order_id) {
      return res.status(400).json({
        success: false,
        error: "Payment and order do not match"
      });
    }

    if (paymentData.status !== "captured") {
      return res.status(400).json({
        success: false,
        error: "Payment is not captured"
      });
    }

    // --------------------------------
    // 8. Payment Document
    // --------------------------------
    const paymentRef = db
      .collection("payments")
      .doc(razorpay_payment_id);

    const paymentSnap = await paymentRef.get();

    // Already processed = do not pay commission twice
    if (
      paymentSnap.exists &&
      paymentSnap.data()?.commissionProcessed === true
    ) {
      return res.status(200).json({
        success: true,
        alreadyProcessed: true,
        message: "Payment was already processed.",
        paymentId: razorpay_payment_id,
        orderId: razorpay_order_id
      });
    }

    // --------------------------------
    // 9. Buyer
    // --------------------------------
    const buyerRef = db
      .collection("users")
      .doc(buyerUid);

    const buyerSnap = await buyerRef.get();

    if (!buyerSnap.exists) {
      return res.status(404).json({
        success: false,
        error: "Buyer account not found"
      });
    }

    const buyerData = buyerSnap.data() || {};

    // --------------------------------
    // 10. Build Upline
    // --------------------------------
    const upline = [];
    const visited = new Set();

    let currentReferral =
      buyerData.referral || "";

    for (let generation = 1; generation <= 5; generation++) {
      if (
        !currentReferral ||
        currentReferral === "Direct"
      ) {
        break;
      }

      if (visited.has(currentReferral)) {
        break;
      }

      visited.add(currentReferral);

      const referrerQuery = await db
        .collection("users")
        .where("userID", "==", currentReferral)
        .limit(1)
        .get();

      if (referrerQuery.empty) {
        break;
      }

      const referrerDoc =
        referrerQuery.docs[0];

      const referrerData =
        referrerDoc.data() || {};

      upline.push({
        uid: referrerDoc.id,
        userID: referrerData.userID || "",
        generation,
        referral:
          referrerData.referral || ""
      });

      currentReferral =
        referrerData.referral || "";
    }

    // --------------------------------
    // 11. Calculate Commission
    // --------------------------------
    const packagePrice = PACKAGE_PRICES[packageName];

    let totalCommission = 0;
    const commissions = [];

    // Direct referrer = Generation 1
    if (upline.length >= 1) {
      const direct = upline[0];

      const directUserRef = db
        .collection("users")
        .doc(direct.uid);

      const directUserSnap =
        await directUserRef.get();

      const directUserData =
        directUserSnap.data() || {};

      const oldDirectCount = Number(
        directUserData.directReferralCount || 0
      );

      const newDirectCount =
        oldDirectCount + 1;

      // Level 60 is maximum
      const level = Math.min(
        newDirectCount,
        60
      );

      const rate =
        directRateForLevel(level);

      const commission =
        Math.round(
          packagePrice * rate * 100
        ) / 100;

      commissions.push({
        uid: direct.uid,
        userID: direct.userID,
        generation: 1,
        level,
        rate,
        amount: commission
      });

      totalCommission += commission;
    }

    // Generation 2-5
    for (const person of upline.slice(1)) {
      const rate =
        generationRate(person.generation);

      if (rate <= 0) continue;

      const commission =
        Math.round(
          packagePrice * rate * 100
        ) / 100;

      commissions.push({
        uid: person.uid,
        userID: person.userID,
        generation: person.generation,
        rate,
        amount: commission
      });

      totalCommission += commission;
    }

    const idwpAmount =
      Math.round(
        (packagePrice - totalCommission) * 100
      ) / 100;

    // --------------------------------
    // 12. Firestore Transaction
    // --------------------------------
    await db.runTransaction(async (transaction) => {

      const freshPaymentSnap =
        await transaction.get(paymentRef);

      if (
        freshPaymentSnap.exists &&
        freshPaymentSnap.data()?.commissionProcessed === true
      ) {
        return;
      }

      const freshBuyerSnap =
        await transaction.get(buyerRef);

      if (!freshBuyerSnap.exists) {
        throw new Error(
          "Buyer account not found"
        );
      }

      // Activate package
      transaction.set(
        buyerRef,
        {
          package: packageName,
          packagePrice,
          packageActive: true,
          packagePaymentId:
            razorpay_payment_id,
          packageActivatedAt:
            FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      // Direct referrer
      if (upline.length >= 1) {
        const direct = upline[0];

        const directRef = db
          .collection("users")
          .doc(direct.uid);

        const directSnap =
          await transaction.get(directRef);

        const directData =
          directSnap.data() || {};

        const oldCount = Number(
          directData.directReferralCount || 0
        );

        const newCount = oldCount + 1;

        const level = Math.min(
          newCount,
          60
        );

        const rate =
          directRateForLevel(level);

        transaction.set(
          directRef,
          {
            directReferralCount: newCount,
            level,
            referralCommissionRate: rate,
            freePackageEligible:
              newCount >= 8
          },
          { merge: true }
        );
      }

      // Add commission to each referrer
      for (const item of commissions) {
        const referrerRef = db
          .collection("users")
          .doc(item.uid);

        transaction.set(
          referrerRef,
          {
            referralEarnings:
              FieldValue.increment(
                item.amount
              )
          },
          { merge: true }
        );
      }

      // Payment record
      transaction.set(
        paymentRef,
        {
          uid: buyerUid,
          userID:
            buyerData.userID || "",
          package: packageName,
          amount: packagePrice,
          paymentId:
            razorpay_payment_id,
          orderId:
            razorpay_order_id,
          status: "Paid",
          commissionProcessed: true,
          totalCommission,
          idwpAmount,
          commissions,
          processedAt:
            FieldValue.serverTimestamp(),
          createdAt:
            FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      // Commission ledger
      for (const item of commissions) {
        const ledgerRef = db
          .collection("commissionLedger")
          .doc();

        transaction.set(
          ledgerRef,
          {
            uid: item.uid,
            userID: item.userID,
            buyerUid,
            buyerUserID:
              buyerData.userID || "",
            generation: item.generation,
            level: item.level || null,
            rate: item.rate,
            amount: item.amount,
            package: packageName,
            packagePrice,
            paymentId:
              razorpay_payment_id,
            orderId:
              razorpay_order_id,
            status: "credited",
            createdAt:
              FieldValue.serverTimestamp()
          }
        );
      }

      // IDWP share
      const idwpRef = db
        .collection("platformLedger")
        .doc();

      transaction.set(
        idwpRef,
        {
          type: "package_sale",
          package: packageName,
          amount: packagePrice,
          totalCommission,
          idwpAmount,
          paymentId:
            razorpay_payment_id,
          orderId:
            razorpay_order_id,
          createdAt:
            FieldValue.serverTimestamp()
        }
      );
    });

    // --------------------------------
    // 13. Success
    // --------------------------------
    return res.status(200).json({
      success: true,
      message:
        "Payment verified and package activated successfully.",
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      package: packageName,
      amount: packagePrice,
      totalCommission,
      idwpAmount,
      commissions
    });

  } catch (error) {
    console.error(
      "Verify payment error:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        error.message ||
        "Server error"
    });
  }
}
