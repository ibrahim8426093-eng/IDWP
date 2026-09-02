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
      error: "Method not allowed"
    });
  }

  try {
    getFirebaseAdmin();

    // -----------------------------
    // 1. Check Firebase Login Token
    // -----------------------------
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Login required"
      });
    }

    const idToken = authHeader.substring(7);

    let decodedToken;

    try {
      decodedToken = await getAuth().verifyIdToken(idToken);
    } catch (error) {
      return res.status(401).json({
        error: "Invalid or expired login session"
      });
    }

    const uid = decodedToken.uid;

    // -----------------------------
    // 2. Get Package Name
    // -----------------------------
    const { packageName } = req.body || {};

    if (!packageName) {
      return res.status(400).json({
        error: "Package name is required"
      });
    }

    // -----------------------------
    // 3. Get Real Price From Server
    // -----------------------------
    const packagePrice = packages[packageName];

    if (!packagePrice) {
      return res.status(400).json({
        error: "Invalid package"
      });
    }

    // -----------------------------
    // 4. Check User Exists
    // -----------------------------
    const db = getFirestore();

    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({
        error: "User account not found"
      });
    }

    const userData = userSnap.data() || {};

    // -----------------------------
    // 5. Create Razorpay Order
    // -----------------------------
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      return res.status(500).json({
        error: "Razorpay environment variables missing"
      });
    }

    const auth = Buffer
      .from(`${keyId}:${keySecret}`)
      .toString("base64");

    const receipt = `idwp_${Date.now()}_${uid.substring(0, 8)}`;

    const response = await fetch(
      "https://api.razorpay.com/v1/orders",
      {
        method: "POST",
        headers: {
          "Authorization": `Basic ${auth}`,
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

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error:
          data.error?.description ||
          "Razorpay order creation failed"
      });
    }

    // -----------------------------
    // 6. Save Order In Firestore
    // -----------------------------
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

    // -----------------------------
    // 7. Send Order To Frontend
    // -----------------------------
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
      error: error.message || "Server error"
    });
  }
}
