const { initFirebase, methodGuard } = require("../firebase-helper");

module.exports = async function handler(req, res) {
  if (methodGuard(req, res)) return;

  try {
    // Verify logged-in user
    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({
        success: false,
        message: "Please log in again."
      });
    }

    const admin = initFirebase();
    const db = admin.firestore();
    const FieldValue = admin.firestore.FieldValue;

    const decoded = await admin.auth().verifyIdToken(match[1]);
    const uid = decoded.uid;

    const amount = Number(req.body?.amount);
    const upiId = String(req.body?.upiId || "").trim();

    // Validate amount
    if (!Number.isSafeInteger(amount) || amount < 100) {
      return res.status(400).json({
        success: false,
        message: "Minimum withdrawal amount is ₹100."
      });
    }

    // Validate UPI ID
    if (!/^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/.test(upiId)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid UPI ID."
      });
    }

    const userRef = db.collection("users").doc(uid);

    // Generate ONE ID for all records
    const requestRef = db.collection("withdrawalRequests").doc();
    const withdrawalRef = db.collection("withdrawals").doc(requestRef.id);
    const historyRef = userRef.collection("withdrawals").doc(requestRef.id);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);

      if (!userSnap.exists) {
        throw new Error("USER_NOT_FOUND");
      }

      const user = userSnap.data();

      const earnings = Number(user.earnings ?? user.totalEarnings ?? 0);
      const withdrawn = Number(user.withdrawn || 0);
      const pendingWithdrawal = Number(user.pendingWithdrawal || 0);
      const pendingReferral = Number(user.pendingReferralCommission || 0);

      if (
        !Number.isFinite(earnings) ||
        !Number.isFinite(withdrawn) ||
        !Number.isFinite(pendingWithdrawal) ||
        !Number.isFinite(pendingReferral)
      ) {
        throw new Error("INVALID_BALANCE");
      }

      // Match wallet display calculation
      const available = Math.max(
        0,
        earnings - withdrawn - pendingWithdrawal - pendingReferral
      );

      if (available < amount) {
        throw new Error("INSUFFICIENT_BALANCE");
      }

      const requestData = {
        uid,
        amount,
        upiId,
        status: "pending",
        paymentProvider: "NOT_YET_PROCESSED",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };

      // Reserve amount until rejection or payment completion
      tx.update(userRef, {
        pendingWithdrawal: FieldValue.increment(amount)
      });

      // Main request
      tx.set(requestRef, requestData);

      // Payout status endpoint reads this
      tx.set(withdrawalRef, requestData);

      // Withdrawal history screen reads this
      tx.set(historyRef, requestData);
    });

    return res.status(200).json({
      success: true,
      message: "Withdrawal request submitted successfully.",
      requestId: requestRef.id,
      status: "pending"
    });

  } catch (error) {
    console.error("request-withdrawal error:", error);

    if (error.message === "USER_NOT_FOUND") {
      return res.status(404).json({
        success: false,
        message: "User account not found."
      });
    }

    if (error.message === "INSUFFICIENT_BALANCE") {
      return res.status(400).json({
        success: false,
        message: "Insufficient available balance."
      });
    }

    if (error.message === "INVALID_BALANCE") {
      return res.status(400).json({
        success: false,
        message: "Your wallet balance data is invalid. Please contact support."
      });
    }

    return res.status(500).json({
      success: false,
      message: "Unable to submit withdrawal request."
    });
  }
};
