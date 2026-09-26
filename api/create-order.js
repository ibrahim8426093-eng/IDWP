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

const PACKAGES = {
  "Lead Generation": 460,
  "Commission Skill": 400,
  "Data Entry": 488,
  "Video Editing": 500,
  "Freelancing": 350,
  "Content Creation": 300
};

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

    const { packageName, customerPhone } = req.body || {};

    const amount = PACKAGES[packageName];

    if (!amount) {
      return res.status(400).json({
        success: false,
        error: "Invalid package"
      });
    }

    const phone = String(
      customerPhone || decoded.phone_number || "9999999999"
    )
      .replace(/\D/g, "")
      .slice(-10);

    if (phone.length !== 10) {
      return res.status(400).json({
        success: false,
        error: "Valid 10 digit mobile number is required"
      });
    }

    const orderId =
      "IDWP_" +
      Date.now().toString(36).toUpperCase() +
      "_" +
      Math.random().toString(36).slice(2, 8).toUpperCase();

    const isSandbox = environment === "sandbox";

    const baseUrl = isSandbox
      ? "https://sandbox.cashfree.com/pg"
      : "https://api.cashfree.com/pg";

    const origin =
      req.headers.origin ||
      "https://ibrahim8426093-eng.github.io";

    const response = await fetch(`${baseUrl}/orders`, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-client-id": clientId,
        "x-client-secret": clientSecret,
        "x-api-version": "2025-01-01",
        "x-idempotency-key": orderId
      },

      body: JSON.stringify({
        order_id: orderId,
        order_amount: amount,
        order_currency: "INR",

        customer_details: {
          customer_id: uid,
          customer_phone: phone,
          customer_email: decoded.email || undefined,
          customer_name: decoded.name || "IDWP Customer"
        },

        order_meta: {
          return_url: `${origin}/IDWP/?order_id={order_id}`
        },

        order_note: `IDWP ${packageName}`
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(
        "Cashfree create order error:",
        response.status,
        data
      );

      return res.status(response.status).json({
        success: false,
        error:
          data?.message ||
          data?.type ||
          "Cashfree order creation failed",
        details: data
      });
    }

    const db = admin.firestore();

    await db.collection("orders").doc(orderId).set({
      orderId,
      uid,
      packageName,
      amount,
      status: "CREATED",
      environment: isSandbox ? "sandbox" : "production",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.status(200).json({
      success: true,
      orderId,
      paymentSessionId: data.payment_session_id,
      mode: isSandbox ? "sandbox" : "production"
    });

  } catch (error) {

    console.error("create-order error:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Server error"
    });
  }
};
