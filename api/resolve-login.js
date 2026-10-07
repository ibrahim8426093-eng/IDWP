const admin = require("firebase-admin");

function getFirebaseAdmin() {
  if (admin.apps.length) {
    return admin;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Firebase environment variables are missing. Required: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY"
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, "\n"),
    }),
  });

  return admin;
}

function normalizeMobile(value) {
  return String(value || "").replace(/\D/g, "");
}

function isValidIndianMobile(value) {
  return /^[6-9]\d{9}$/.test(value);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  try {
    const firebaseAdmin = getFirebaseAdmin();
    const db = firebaseAdmin.firestore();

    const { identifier } = req.body || {};

    if (!identifier) {
      return res.status(400).json({
        success: false,
        error: "Mobile number or email is required.",
      });
    }

    const value = String(identifier).trim();

    // --------------------------------
    // 1. EMAIL LOGIN
    // --------------------------------
    if (value.includes("@")) {
      const email = value.toLowerCase();

      try {
        const userRecord =
          await firebaseAdmin.auth().getUserByEmail(email);

        return res.status(200).json({
          success: true,
          email: userRecord.email,
          uid: userRecord.uid,
          loginType: "email",
        });
      } catch (err) {
        return res.status(404).json({
          success: false,
          error: "No IDWP account found with this email.",
        });
      }
    }

    // --------------------------------
    // 2. MOBILE LOGIN
    // --------------------------------
    const mobile = normalizeMobile(value);

    if (!isValidIndianMobile(mobile)) {
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
      error: error.message || "Unable to process login right now.",
    });
  }
};
