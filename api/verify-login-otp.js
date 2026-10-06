const admin = require("firebase-admin");
const crypto = require("crypto");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

function hashOTP(otp) {
  return crypto
    .createHash("sha256")
    .update(otp)
    .digest("hex");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const { email, otp } = req.body || {};

    if (!email || !otp) {
      return res.status(400).json({
        error: "Email and OTP are required.",
      });
    }

    const normalizedEmail = String(email)
      .trim()
      .toLowerCase();

    const enteredOTP = String(otp).trim();

    if (!/^\d{6}$/.test(enteredOTP)) {
      return res.status(400).json({
        error: "OTP must be exactly 6 digits.",
      });
    }

    // Find the latest unused OTP for this email.
    const snapshot = await db
      .collection("loginOtps")
      .where("email", "==", normalizedEmail)
      .where("used", "==", false)
      .get();

    if (snapshot.empty) {
      return res.status(400).json({
        error: "OTP not found. Please request a new OTP.",
      });
    }

    // Find the newest OTP without requiring a Firestore composite index.
    let otpDoc = null;

    snapshot.forEach((doc) => {
      const data = doc.data();

      if (!otpDoc) {
        otpDoc = doc;
        return;
      }

      const current = data.createdAt?.toMillis?.() || 0;
      const previous =
        otpDoc.data().createdAt?.toMillis?.() || 0;

      if (current > previous) {
        otpDoc = doc;
      }
    });

    if (!otpDoc) {
      return res.status(400).json({
        error: "OTP not found.",
      });
    }

    const otpData = otpDoc.data();

    // Maximum 5 wrong attempts.
    const attempts = Number(otpData.attempts || 0);

    if (attempts >= 5) {
      await otpDoc.ref.update({
        used: true,
        failed: true,
      });

      return res.status(429).json({
        error:
          "Too many incorrect OTP attempts. Please request a new OTP.",
      });
    }

    // Check OTP expiry.
    if (
      !otpData.expiresAt ||
      otpData.expiresAt.toMillis() < Date.now()
    ) {
      await otpDoc.ref.update({
        used: true,
        expired: true,
      });

      return res.status(400).json({
        error: "OTP has expired. Please request a new OTP.",
      });
    }

    const enteredHash = hashOTP(enteredOTP);

    // Wrong OTP.
    if (enteredHash !== otpData.otpHash) {
      const newAttempts = attempts + 1;

      await otpDoc.ref.update({
        attempts: newAttempts,
      });

      return res.status(401).json({
        error:
          newAttempts >= 5
            ? "Too many incorrect attempts. Please request a new OTP."
            : `Incorrect OTP. ${5 - newAttempts} attempts remaining.`,
      });
    }

    // OTP is correct.
    await otpDoc.ref.update({
      used: true,
      verified: true,
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Verify that the Firebase account still exists.
    let userRecord;

    try {
      userRecord = await admin.auth().getUserByEmail(
        normalizedEmail
      );
    } catch (error) {
      return res.status(404).json({
        error: "IDWP account not found.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully.",
      uid: userRecord.uid,
      email: userRecord.email,
      loginVerified: true,
    });

  } catch (error) {
    console.error("verify-login-otp error:", error);

    return res.status(500).json({
      error: "Unable to verify OTP right now.",
    });
  }
};
