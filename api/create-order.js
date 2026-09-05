import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const packages = {
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

function getFirebaseAdmin() {
  if (getApps().length) {
    return getApps()[0];
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing");
  }

  const serviceAccount = JSON.parse(raw);

  return initializeApp({
    credential: cert(serviceAccount)
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

    const uid = decodedToken.uid;

    const { packageName } = req.body || {};

    if (!packageName) {
      return res.status(400).json({
        success: false,
        error: "Package name is required"
      });
    }

    const packagePrice = packages[packageName];

    if (!packagePrice) {
      return res.status(400).json({
        success: false,
        error: "Invalid package"
      });
    }

    const db = getFirestore();

    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({
        success: false,
        error: "User account not found"
      });
    }

    const userData = userSnap.data() || {};

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      return res.status(500).json({
        success: false,
        error: "Razorpay environment variables missing"
      });
    }

    const razorpayAuth = Buffer
      .from(`${keyId}:${keySecret}`)
      .toString("base64");

    const receipt =
      `idwp_${Date.now()}_${uid.substring(0, 8)}`;

    const razorpayResponse = await fetch(
      "https://api.razorpay.com/v1/orders",
      {
        method: "POST",
        headers: {
          "Authorization": `Basic ${razorpayAuth}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: Math.round(packagePrice * 100),
          currency: "INR",
          receipt,
          notes: {
            uid,
            userID: userData.userID || "",
            packageName
          }
        })
      }
    );

    const data = await razorpayResponse.json();

    if (!razorpayResponse.ok) {
      return res.status(razorpayResponse.status).json({
        success: false,
        error:
          data?.error?.description ||
          "Razorpay order creation failed"
      });
    }

    await db.collection("orders").doc(data.id).set({
      orderId: data.id,
      uid,
      userID: userData.userID || "",
      package: packageName,
      amount: packagePrice,
      currency: "INR",
      status: "created",
      createdAt: new Date()
    });

    return res.status(200).json({
      success: true,
      orderId: data.id,
      amount: data.amount,
      currency: data.currency,
      keyId
    });

  } catch (error) {
    console.error("Create order error:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Server error"
    });
  }
}
