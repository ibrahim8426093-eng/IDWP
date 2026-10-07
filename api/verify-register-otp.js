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

const PACKAGES = {
  "Lead Generation": 460,
  "Commission Skill": 400,
  "Data Entry": 488,
  "Video Editing": 500,
  "Freelancing": 350,
  "Content Creation": 300,
};

function hashOTP(otp) {
  return crypto
    .createHash("sha256")
    .update(otp)
    .digest("hex");
}

function decryptPassword(encrypted, ivBase64, tagBase64) {
  const keyText = process.env.REGISTRATION_ENCRYPTION_KEY;

  if (!keyText) {
    throw new Error(
      "REGISTRATION_ENCRYPTION_KEY is not configured."
    );
  }

  const key = crypto
    .createHash("sha256")
    .update(keyText)
    .digest();

  const iv = Buffer.from(ivBase64, "base64");
  const tag = Buffer.from(tagBase64, "base64");
  const encryptedBuffer = Buffer.from(
    encrypted,
    "base64"
  );

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encryptedBuffer),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

function generateUserID() {
  return (
    "IDWP" +
    Math.floor(
      100000 + Math.random() * 900000
    )
  );
}

function normalizeMobile(value) {
  return String(value || "").replace(/\D/g, "");
}

function validIndianMobile(value) {
  return /^[6-9]\d{9}$/.test(value);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  let createdAuthUser = null;

  try {
    const {
      email,
      otp,
    } = req.body || {};

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

    // -----------------------------------------
    // Find registration OTP
    // -----------------------------------------

    const snapshot = await db
      .collection("registrationOtps")
      .where("email", "==", normalizedEmail)
      .where("used", "==", false)
      .get();

    if (snapshot.empty) {
      return res.status(400).json({
        error:
          "Registration OTP not found. Please request a new OTP.",
      });
    }

    // Get newest OTP
    let otpDoc = null;

    snapshot.forEach((doc) => {
      const data = doc.data();

      if (!otpDoc) {
        otpDoc = doc;
        return;
      }

      const current =
        data.createdAt?.toMillis?.() || 0;

      const previous =
        otpDoc.data().createdAt?.toMillis?.() || 0;

      if (current > previous) {
        otpDoc = doc;
      }
    });

    if (!otpDoc) {
      return res.status(400).json({
        error: "Registration OTP not found.",
      });
    }

    const otpData = otpDoc.data();

    // -----------------------------------------
    // Attempt limit
    // -----------------------------------------

    const attempts = Number(
      otpData.attempts || 0
    );

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

    // -----------------------------------------
    // Expiry check
    // -----------------------------------------

    if (
      !otpData.expiresAt ||
      otpData.expiresAt.toMillis() < Date.now()
    ) {
      await otpDoc.ref.update({
        used: true,
        expired: true,
      });

      return res.status(400).json({
        error:
          "OTP has expired. Please request a new OTP.",
      });
    }

    // -----------------------------------------
    // Verify OTP
    // -----------------------------------------

    const enteredHash = hashOTP(
      enteredOTP
    );

    if (enteredHash !== otpData.otpHash) {
      const newAttempts = attempts + 1;

      await otpDoc.ref.update({
        attempts: newAttempts,
      });

      return res.status(401).json({
        error:
          newAttempts >= 5
            ? "Too many incorrect OTP attempts. Please request a new OTP."
            : `Incorrect OTP. ${
                5 - newAttempts
              } attempts remaining.`,
      });
    }

    // -----------------------------------------
    // Validate stored registration data
    // -----------------------------------------

    const name = String(
      otpData.name || ""
    ).trim();

    const mobile = normalizeMobile(
      otpData.mobileNormalized ||
      otpData.mobile
    );

    const whatsapp = normalizeMobile(
      otpData.whatsapp
    );

    const referralId = String(
      otpData.referral || ""
    )
      .trim()
      .toUpperCase();

    const packageName = String(
      otpData.package || ""
    ).trim();

    if (!name) {
      return res.status(400).json({
        error:
          "Registration name is missing.",
      });
    }

    if (!validIndianMobile(mobile)) {
      return res.status(400).json({
        error:
          "Invalid registered mobile number.",
      });
    }

    if (!validIndianMobile(whatsapp)) {
      return res.status(400).json({
        error:
          "Invalid registered WhatsApp number.",
      });
    }

    if (!referralId) {
      return res.status(400).json({
        error:
          "Referral ID is required.",
      });
    }

    if (!PACKAGES[packageName]) {
      return res.status(400).json({
        error:
          "Invalid package selected.",
      });
    }

    // -----------------------------------------
    // Check email again
    // -----------------------------------------

    try {
      await admin.auth().getUserByEmail(
        normalizedEmail
      );

      await otpDoc.ref.update({
        used: true,
        failed: true,
      });

      return res.status(409).json({
        error:
          "This email is already registered with IDWP.",
      });
    } catch (error) {
      // user-not-found is expected
    }

    // -----------------------------------------
    // Check mobile uniqueness again
    // -----------------------------------------

    const mobileSnap = await db
      .collection("users")
      .where(
        "mobileNormalized",
        "==",
        mobile
      )
      .limit(1)
      .get();

    if (!mobileSnap.empty) {
      await otpDoc.ref.update({
        used: true,
        failed: true,
      });

      return res.status(409).json({
        error:
          "This mobile number is already registered with IDWP. One mobile number can have only one ID.",
      });
    }

    // -----------------------------------------
    // Verify referral still exists
    // -----------------------------------------

    const referralSnap = await db
      .collection("users")
      .where(
        "userID",
        "==",
        referralId
      )
      .limit(1)
      .get();

    if (referralSnap.empty) {
      return res.status(400).json({
        error:
          "Referral ID is no longer valid.",
      });
    }

    const referralDoc =
      referralSnap.docs[0];

    const referralUser =
      referralDoc.data();

    // -----------------------------------------
    // Decrypt registration password
    // -----------------------------------------

    let password;

    try {
      password = decryptPassword(
        otpData.encryptedPassword,
        otpData.passwordIv,
        otpData.passwordTag
      );
    } catch (error) {
      console.error(
        "Password decrypt error:",
        error
      );

      return res.status(500).json({
        error:
          "Unable to complete registration securely.",
      });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({
        error:
          "Invalid registration password.",
      });
    }

    // -----------------------------------------
    // Generate unique IDWP User ID
    // -----------------------------------------

    let userID = null;

    for (let i = 0; i < 10; i++) {
      const candidate =
        generateUserID();

      const existingID = await db
        .collection("users")
        .where(
          "userID",
          "==",
          candidate
        )
        .limit(1)
        .get();

      if (existingID.empty) {
        userID = candidate;
        break;
      }
    }

    if (!userID) {
      return res.status(500).json({
        error:
          "Unable to generate a unique IDWP User ID. Please try again.",
      });
    }

    // -----------------------------------------
    // Create Firebase Authentication account
    // -----------------------------------------

    try {
      createdAuthUser =
        await admin.auth().createUser({
          email: normalizedEmail,
          password,
          displayName: name,
          emailVerified: true,
        });
    } catch (error) {
      console.error(
        "Firebase Auth creation error:",
        error
      );

      return res.status(400).json({
        error:
          error.message ||
          "Unable to create IDWP account.",
      });
    }

    // -----------------------------------------
    // Create Firestore user document
    // -----------------------------------------

    try {
      await db
        .collection("users")
        .doc(createdAuthUser.uid)
        .set({
          uid: createdAuthUser.uid,

          userID,

          name,

          mobile,

          mobileNormalized: mobile,

          whatsapp,

          email: normalizedEmail,

          referral: referralId,

          package: packageName,

          packagePrice:
            PACKAGES[packageName],

          packageActive: false,

          earnings: 0,

          workEarnings: 0,

          referralEarnings: 0,

          pending: 0,

          pendingReferralCommission: 0,

          availableReferralCommission: 0,

          referralCommissionAvailableAt:
            null,

          nextReferralPayoutAt: null,

          directReferralCount: 0,

          level: 0,

          referralCommissionRate: 0.20,

          freePackageEligible: false,

          freePackageClaimed: false,

          registrationOtpVerified: true,

          createdAt:
            admin.firestore.FieldValue
              .serverTimestamp(),

          updatedAt:
            admin.firestore.FieldValue
              .serverTimestamp(),
        });
    } catch (error) {
      // Remove Firebase Auth account if Firestore creation failed.
      try {
        await admin
          .auth()
          .deleteUser(
            createdAuthUser.uid
          );
      } catch (cleanupError) {
        console.error(
          "Auth cleanup error:",
          cleanupError
        );
      }

      createdAuthUser = null;

      console.error(
        "Firestore user creation error:",
        error
      );

      return res.status(500).json({
        error:
          "Unable to save IDWP account. Please try again.",
      });
    }

    // -----------------------------------------
    // Mark OTP as used
    // -----------------------------------------

    await otpDoc.ref.update({
      used: true,
      verified: true,
      verifiedAt:
        admin.firestore.FieldValue
          .serverTimestamp(),

      createdUserId:
        createdAuthUser.uid,

      createdIDWPUserID: userID,
    });

    // -----------------------------------------
    // Return successful registration
    // -----------------------------------------

    return res.status(200).json({
      success: true,

      message:
        "Registration completed successfully.",

      userID,

      uid:
        createdAuthUser.uid,

      email: normalizedEmail,

      name,

      mobile,

      whatsapp,

      referralId,

      package: packageName,

      packagePrice:
        PACKAGES[packageName],
    });

  } catch (error) {
    console.error(
      "verify-register-otp error:",
      error
    );

    // Extra cleanup if something unexpected happens
    if (createdAuthUser?.uid) {
      try {
        await admin
          .auth()
          .deleteUser(
            createdAuthUser.uid
          );
      } catch (cleanupError) {
        console.error(
          "Unexpected auth cleanup error:",
          cleanupError
        );
      }
    }

    return res.status(500).json({
      error:
        "Unable to complete registration right now.",
    });
  }
};
