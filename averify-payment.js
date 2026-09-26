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
    const clientId = (process.env.CASHFREE_CLIENT_ID || "").trim();
    const clientSecret = (process.env.CASHFREE_CLIENT_SECRET || "").trim();

    const environment =
      (process.env.CASHFREE_ENVIRONMENT || "production")
        .trim()
        .toLowerCase();

    if (!clientId || !clientSecret) {
      return res.status(500).json({
        success: false,
        error: "Cashfree environment variables missing"
      });
    }

    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Login required"
      });
    }

    getFirebaseAdmin();

    const token = authHeader.substring(7);
    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;

    const { orderId } = req.body || {};

    if (!orderId) {
      return res.status(400).json({
        success: false,
        error: "Order ID is required"
      });
    }

    const db = admin.firestore();
    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return res.status(404).json({
        success: false,
        error: "Order not found"
      });
    }

    const order = orderSnap.data();

    if (order.uid !== uid) {
      return res.status(403).json({
        success: false,
        error: "Order does not belong to this user"
      });
    }

    const baseUrl =
      environment === "sandbox"
        ? "https://sandbox.cashfree.com/pg"
        : "https://api.cashfree.com/pg";

    const response = await fetch(
      `${baseUrl}/orders/${encodeURIComponent(orderId)}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "x-client-id": clientId,
          "x-client-secret": clientSecret,
          "x-api-version": "2025-01-01"
        }
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(
        "Cashfree verify error:",
        response.status,
        data
      );

      return res.status(response.status).json({
        success: false,
        error:
          data?.message ||
          data?.type ||
          "Unable to verify payment",
        details: data
      });
    }

    const paymentStatus = String(
      data.order_status || ""
    ).toUpperCase();

    if (paymentStatus !== "PAID") {
      await orderRef.update({
        status: paymentStatus || "PENDING",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return res.status(200).json({
        success: false,
        paid: false,
        status: paymentStatus || "PENDING",
        message: "Payment is not completed"
      });
    }

    await orderRef.update({
      status: "PAID",
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const userRef = db.collection("users").doc(uid);

    await userRef.set(
      {
        package: order.packageName,
        packageActive: true,
        packageAmount: order.amount,
        packageOrderId: orderId,
        packageActivatedAt:
          admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return res.status(200).json({
      success: true,
      paid: true,
      status: "PAID",
      orderId,
      packageName: order.packageName,
      amount: order.amount
    });

  } catch (error) {

    console.error("verify-payment error:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Server error"
    });
  }
};
