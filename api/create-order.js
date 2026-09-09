import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const PACKAGES = {
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
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
}

function initFirebase() {
  if (getApps().length) return;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing");
  }

  initializeApp({
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
    initFirebase();

    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Login required"
      });
    }

    let decodedUser;

    try {
      const token = authorization.substring(7);
      decodedUser = await getAuth().verifyIdToken(token);
    } catch (error) {
      return res.status(401).json({
        success: false,
        error: "Invalid or expired login session"
      });
    }

    const { packageName } = req.body || {};

    const amount = PACKAGES[packageName];

    if (!amount) {
      return res.status(400).json({
        success: false,
        error: "Invalid package"
      });
    }

    const db = getFirestore();

    const userRef = db.collection("users").doc(decodedUser.uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({
        success: false,
        error: "User account not found"
      });
    }

    const userData = userSnap.data();

    const clientId = (process.env.CASHFREE_CLIENT_ID || "").trim();
    const clientSecret = (process.env.CASHFREE_CLIENT_SECRET || "").trim();

    if (!clientId || !clientSecret) {
      return res.status(500).json({
        success: false,
        error: "Cashfree environment variables missing"
      });
    }

    /*
      TEST MODE
      Cashfree Sandbox is being used.
    */

    const cashfreeUrl = "https://sandbox.cashfree.com/pg/orders";

    const orderId =
      "idwp_" +
      Date.now() +
      "_" +
      decodedUser.uid.substring(0, 8);

    const customerId =
      userData.userID ||
      decodedUser.uid;

    const customerPhone = String(
      userData.mobile ||
      userData.whatsapp ||
      "9999999999"
    ).replace(/\D/g, "").slice(-10);

    const customerEmail =
      userData.email ||
      decodedUser.email ||
      "customer@example.com";

    const cashfreeResponse = await fetch(cashfreeUrl, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-api-version": "2025-01-01",
        "x-client-id": clientId,
        "x-client-secret": clientSecret
      },

      body: JSON.stringify({
        order_id: orderId,

        order_amount: amount,

        order_currency: "INR",

        customer_details: {
          customer_id: customerId,
          customer_name: userData.name || "IDWP User",
          customer_email: customerEmail,
          customer_phone: customerPhone
        },

        order_meta: {
          return_url:
            "https://ibrahim8426093-eng.github.io/IDWP/"
        },

        order_note:
          "IDWP Package - " + packageName
      })
    });

    const cashfreeData = await cashfreeResponse.json();

    if (!cashfreeResponse.ok) {
      console.error(
        "Cashfree Create Order Error:",
        cashfreeData
      );

      return res.status(cashfreeResponse.status).json({
        success: false,
        error:
          cashfreeData.message ||
          cashfreeData.type ||
          "Cashfree order creation failed"
      });
    }

    if (!cashfreeData.payment_session_id) {
      console.error(
        "Cashfree response missing payment_session_id:",
        cashfreeData
      );

      return res.status(500).json({
        success: false,
        error: "Cashfree payment session was not received"
      });
    }

    /*
      Save order in Firestore
    */

    await db.collection("orders").doc(orderId).set({
      orderId: orderId,

      uid: decodedUser.uid,

      userID: customerId,

      package: packageName,

      amount: amount,

      currency: "INR",

      gateway: "cashfree",

      status: "created",

      createdAt: new Date()
    });

    return res.status(200).json({
      success: true,

      orderId: orderId,

      amount: amount,

      currency: "INR",

      paymentSessionId:
        cashfreeData.payment_session_id,

      mode: "sandbox"
    });

  } catch (error) {

    console.error(
      "Create Cashfree Order Error:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        error.message ||
        "Internal server error"
    });
  }
}
