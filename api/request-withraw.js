const { initFirebase, methodGuard } = require("../firebase-helper");

module.exports = async function handler(req, res) {
  if (methodGuard(req, res)) return;

  try {
    const authorization = req.headers.authorization || "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({
        success: false,
        message: "Please log in again."
      });
    }

    const admin = initFirebase();
    const db = admin.firestore();

    const decodedToken = await admin.auth().verifyIdToken(match[1]);
    const uid = decodedToken.uid;

    const amount = Number(req.body?.amount);
    const upiId = String(req.body?.upiId || "").trim();

    if (!Number.isFinite(amount) || amount < 100) {
      return res.status(400).json({
        success: false,
        message: "Minimum withdrawal amount is ₹100."
      });
    }

    if (!/^[\w.-]{2,256}@[a-zA-Z]{2,64}$/.test(upiId)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid UPI ID."
      });
    }

    const userRef = db.collection("users").doc(uid);
    const requestRef = db.collection("withdrawalRequests").doc();

    await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        throw new Error("USER_NOT_FOUND");
      }

      const userData = userDoc.data();
      const balance = Number(userData.balance || 0);

      if (balance < amount) {
        throw new Error("INSUFFICIENT_BALANCE");
      }

      transaction.update(userRef, {
        balance: admin.firestore.FieldValue.increment(-amount)
      });

      transaction.set(requestRef, {
        uid,
        amount,
        upiId,
        status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.status(200).json({
      success: true,
      message: "Withdrawal request submitted successfully.",
      requestId: requestRef.id
    });
  } catch (error) {
    console.error("request-withdrawal error:", error.message);

    if (error.message === "USER_NOT_FOUND") {
      return res.status(404).json({
        success: false,
        message: "User account not found."
      });
    }

    if (error.message === "INSUFFICIENT_BALANCE") {
      return res.status(400).json({
        success: false,
        message: "Insufficient balance."
      });
    }

    return res.status(500).json({
      success: false,
      message: "Unable to submit withdrawal request."
    });
  }
};
