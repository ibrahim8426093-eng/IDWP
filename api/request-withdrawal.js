import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function getFirebaseAdmin() {
  if (getApps().length) return getApps()[0];

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing");
  }

  return initializeApp({
    credential: cert(JSON.parse(raw))
  });
}

export default async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    getFirebaseAdmin();

    // -----------------------------
    // LOGIN CHECK
    // -----------------------------
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Login required"
      });
    }

    let decoded;

    try {
      decoded = await getAuth().verifyIdToken(
        authHeader.slice(7)
      );
    } catch (e) {
      return res.status(401).json({
        success: false,
        error: "Invalid or expired login session"
      });
    }

    // -----------------------------
    // REQUEST DATA
    // -----------------------------
    const {
      amount,
      upiId,
      bankAccount,
      ifsc,
      accountHolderName
    } = req.body || {};

    const withdrawalAmount = Number(amount);

    if (!withdrawalAmount || withdrawalAmount < 100) {
      return res.status(400).json({
        success: false,
        error: "Minimum withdrawal amount is ₹100"
      });
    }

    if (!upiId && (!bankAccount || !ifsc)) {
      return res.status(400).json({
        success: false,
        error: "UPI ID or Bank Account + IFSC is required"
      });
    }

    // -----------------------------
    // FIRESTORE
    // -----------------------------
    const db = getFirestore();

    const userRef = db
      .collection("users")
      .doc(decoded.uid);

    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({
        success: false,
        error: "User account not found"
      });
    }

    const user = userSnap.data() || {};

    // -----------------------------
    // CHECK AVAILABLE BALANCE
    // -----------------------------
    const workEarnings = Number(user.workEarnings || 0);
    const referralEarnings = Number(user.referralEarnings || 0);

    const totalEarnings =
      Number(user.totalEarnings || (
        workEarnings + referralEarnings
      ));

    const withdrawn =
      Number(user.withdrawn || 0);

    const pendingWithdrawal =
      Number(user.pendingWithdrawal || 0);

    const availableBalance =
      totalEarnings -
      withdrawn -
      pendingWithdrawal;

    if (withdrawalAmount > availableBalance) {
      return res.status(400).json({
        success: false,
        error:
          `Insufficient balance. Available: ₹${availableBalance.toFixed(2)}`
      });
    }

    // -----------------------------
    // CASHFREE CONFIG CHECK
    // -----------------------------
    const clientId =
      (process.env.CASHFREE_CLIENT_ID || "").trim();

    const clientSecret =
      (process.env.CASHFREE_CLIENT_SECRET || "").trim();

    if (!clientId || !clientSecret) {
      return res.status(500).json({
        success: false,
        error: "Cashfree environment variables missing"
      });
    }

    // -----------------------------
    // CREATE WITHDRAWAL REQUEST
    // -----------------------------
    const withdrawalRef =
      db.collection("withdrawals").doc();

    const withdrawalId = withdrawalRef.id;

    await withdrawalRef.set({
      withdrawalId,
      uid: decoded.uid,
      userID: user.userID || "",
      amount: withdrawalAmount,

      upiId: upiId || "",
      bankAccount: bankAccount || "",
      ifsc: ifsc || "",
      accountHolderName: accountHolderName || user.name || "",

      status: "PENDING",
      paymentProvider: "CASHFREE",

      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    // -----------------------------
    // UPDATE USER PENDING BALANCE
    // -----------------------------
    await userRef.update({
      pendingWithdrawal:
        pendingWithdrawal + withdrawalAmount,

      lastWithdrawalId: withdrawalId,

      updatedAt: FieldValue.serverTimestamp()
    });

    return res.status(200).json({
      success: true,
      message:
        "Withdrawal request submitted successfully",
      withdrawalId,
      amount: withdrawalAmount,
      status: "PENDING"
    });

  } catch (error) {
    console.error(
      "Cashfree withdrawal error:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        error.message || "Withdrawal request failed"
    });
  }
}
