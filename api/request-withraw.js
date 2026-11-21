const { initFirebase, methodGuard } = require("../firebase-helper");

module.exports = async function handler(req, res) {
  if (methodGuard(req, res)) return;

  try {
    const auth = req.headers.authorization || "";
    const match = auth.match(/^Bearer\s+(.+)$/i);

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

    if (!Number.isInteger(amount) || amount < 100) {
      return res.status(400).json({
        success: false,
        message: "Minimum withdrawal amount is ₹100."
      });
    }

    if (!/^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/.test(upiId)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid UPI ID."
      });
    }

    const userRef = db.collection("users").doc(uid);

    // Same request ID used in all withdrawal records
    const requestRef = db.collection("withdrawalRequests").doc();
    const withdrawalRef = db.collection("withdrawals").doc(requestRef.id);
    const historyRef = userRef.collection("withdrawals").doc(requestRef.id);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);

      if (!userSnap.exists) {
        throw new Error("USER_NOT_FOUND");
      }

      const user = userSnap.data();

      const totalEarnings = Number(
        user.earnings ?? user.totalEarnings ?? 0
      );

      const withdrawn = Number(user.withdrawn || 0);
      const pending = Number(user.pendingWithdrawal || 0);
      const pendingReferral = Number(user.pendingReferralCommission || 0);

      const available = Math.max(
        0,
        totalEarnings - withdrawn - pending - pendingReferral
      );

      if (available < amount) {
        throw new Error("INSUFFICIENT_BALANCE");
      }

      const requestData = {
        uid,
        amount,
        upiId,
        status: "pending",
        paymentProvider: "CASHFREE_PAYOUTS",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };

      // Reserve amount while payout is pending.
      tx.update(userRef, {
        pendingWithdrawal: FieldValue.increment(amount)
      });

      // Main request collection
      tx.set(requestRef, requestData);

      // Payout status API reads this collection
      tx.set(withdrawalRef, requestData);

      // User history screen reads this subcollection
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

    return res.status(500).json({
      success: false,
      message: "Unable to submit withdrawal request."
    });
  }
};
