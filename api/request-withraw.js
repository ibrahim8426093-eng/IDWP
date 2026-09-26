const admin = require("firebase-admin");

function getFirebaseAdmin() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

    if (!raw) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing");
    }

    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw))
    });
  }

  return admin;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    getFirebaseAdmin();

    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Login required"
      });
    }

    const token = authHeader.substring(7);
    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;

    const { upiId, upi, amount } = req.body || {};

    const finalUpi = String(upiId || upi || "").trim();
    const finalAmount = Number(amount);

    if (!finalUpi) {
      return res.status(400).json({
        success: false,
        error: "UPI ID is required"
      });
    }

    if (!Number.isFinite(finalAmount) || finalAmount < 100) {
      return res.status(400).json({
        success: false,
        error: "Minimum withdrawal amount is ₹100"
      });
    }

    const db = admin.firestore();
    const userRef = db.collection("users").doc(uid);

    const withdrawalId = "WD_" + Date.now();

    const result = await db.runTransaction(async (transaction) => {
      const userSnap = await transaction.get(userRef);

      if (!userSnap.exists) {
        throw new Error("User account not found");
      }

      const user = userSnap.data();

      const availableEarnings = Number(
        user.earnings ??
        user.availableEarnings ??
        user.walletBalance ??
        0
      );

      if (availableEarnings < finalAmount) {
        throw new Error("Insufficient earnings balance");
      }

      const newBalance = availableEarnings - finalAmount;

      transaction.set(
        userRef,
        {
          earnings: newBalance,
          availableEarnings: newBalance,
          walletBalance: newBalance
        },
        { merge: true }
      );

      const withdrawalData = {
        withdrawalId,
        uid,
        upiId: finalUpi,
        amount: finalAmount,
        status: "PENDING",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };

      const topLevelRef = db
        .collection("withdrawals")
        .doc(withdrawalId);

      const userWithdrawalRef = userRef
        .collection("withdrawals")
        .doc(withdrawalId);

      transaction.set(topLevelRef, withdrawalData);
      transaction.set(userWithdrawalRef, withdrawalData);

      return {
        withdrawalId,
        remainingBalance: newBalance
      };
    });

    return res.status(200).json({
      success: true,
      message: "Withdrawal request submitted",
      withdrawalId: result.withdrawalId,
      remainingBalance: result.remainingBalance
    });

  } catch (error) {

    console.error("withdrawal error:", error);

    return res.status(400).json({
      success: false,
      error: error.message || "Withdrawal request failed"
    });
  }
};
