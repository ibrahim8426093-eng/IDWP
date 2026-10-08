const admin = require("firebase-admin");

const ALLOWED_ORIGIN = "https://ibrahim8426093-eng.github.io";

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  // Browser CORS preflight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  try {
    // Firebase Admin initialize
    if (!admin.apps.length) {
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const privateKey = process.env.FIREBASE_PRIVATE_KEY;

      if (!projectId || !clientEmail || !privateKey) {
        console.error("Missing Firebase Admin environment variables:", {
          projectId: !!projectId,
          clientEmail: !!clientEmail,
          privateKey: !!privateKey,
        });

        return res.status(500).json({
          success: false,
          error: "Firebase server configuration is missing.",
        });
      }

      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey: privateKey.replace(/\\n/g, "\n"),
        }),
      });
    }

    const db = admin.firestore();

    const { identifier } = req.body || {};

    if (!identifier) {
      return res.status(400).json({
        success: false,
        error: "Mobile number or email is required.",
      });
    }

    const value = String(identifier).trim();

    // EMAIL LOGIN
    if (value.includes("@")) {
      const email = value.toLowerCase();

      try {
        const userRecord = await admin.auth().getUserByEmail(email);

        return res.status(200).json({
          success: true,
          email: userRecord.email,
          uid: userRecord.uid,
          loginType: "email",
        });
      } catch (err) {
        console.error("Email lookup error:", err);

        return res.status(404).json({
          success: false,
          error: "No IDWP account found with this email.",
        });
      }
    }

    // MOBILE LOGIN
    const mobile = value.replace(/\D/g, "");

    if (!/^[6-9]\d{9}$/.test(mobile)) {
      return res.status(400).json({
        success: false,
        error: "Enter a valid 10-digit Indian mobile number.",
      });
    }

    const snapshot = await db
      .collection("users")
      .where("mobileNormalized", "==", mobile)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({
        success: false,
        error: "No IDWP account found with this mobile number.",
      });
    }

    const userDoc = snapshot.docs[0];
    const userData = userDoc.data();

    if (!userData.email) {
      return res.status(400).json({
        success: false,
        error: "This IDWP account does not have a registered email.",
      });
    }

    return res.status(200).json({
      success: true,
      email: String(userData.email).toLowerCase(),
      uid: userData.uid || userDoc.id,
      userID: userData.userID || null,
      loginType: "mobile",
    });

  } catch (error) {
    console.error("resolve-login error:", error);

    return res.status(500).json({
      success: false,
      error: "Unable to process login right now.",
    });
  }
};
