
const { initFirebase, methodGuard } = require("../firebase-helper");

const PACKAGES = {
  "Lead Generation": 460,
  "Commission Skill": 400,
  "Data Entry": 488,
  "Video Editing": 500,
  "Freelancing": 350,
  "Content Creation": 300
};

function generateUserID() {
  return "IDWP" + Math.floor(100000 + Math.random() * 900000);
}

function normalizeMobile(value) {
  return String(value || "").replace(/\D/g, "");
}

module.exports = async function handler(req, res) {
  if (methodGuard(req, res)) return;

  let createdUid = null;

  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const mobile = String(req.body?.mobile || "").trim();
    const whatsapp = String(
      req.body?.whatsappNumber || req.body?.whatsapp || mobile
    ).trim();
    const referral = String(
      req.body?.referralId || req.body?.referral || ""
    ).trim().toUpperCase();
    const packageName = String(
      req.body?.package || ""
    ).trim();
    const password = String(req.body?.password || "");

    const mobileNormalized = normalizeMobile(mobile);

    if (!name || name.length > 100) {
      return res.status(400).json({
        success: false,
        error: "Please enter a valid name."
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        success: false,
        error: "Please enter a valid email address."
      });
    }

    if (mobileNormalized.length < 10 ||
        mobileNormalized.length > 15) {
      return res.status(400).json({
        success: false,
        error: "Please enter a valid mobile number."
      });
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({
        success: false,
        error: "Password must be at least 8 characters."
      });
    }

    if (!PACKAGES[packageName]) {
      return res.status(400).json({
        success: false,
        error: "Please select a valid package."
      });
    }

    if (!referral) {
      return res.status(400).json({
        success: false,
        error: "Please enter a valid referral ID."
      });
    }

    const admin = initFirebase();
    const auth = admin.auth();
    const db = admin.firestore();

    // Reject duplicate email.
    try {
      await auth.getUserByEmail(email);

      return res.status(409).json({
        success: false,
        error: "This email is already registered with IDWP."
      });
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }

    // Reject duplicate mobile number.
    const mobileSnap = await db
      .collection("users")
      .where("mobileNormalized", "==", mobileNormalized)
      .limit(1)
      .get();

    if (!mobileSnap.empty) {
      return res.status(409).json({
        success: false,
        error: "This mobile number is already registered with IDWP."
      });
    }

    // Validate the referral against an existing user.
    const referralSnap = await db
      .collection("users")
      .where("userID", "==", referral)
      .limit(1)
      .get();

    if (referralSnap.empty) {
      return res.status(400).json({
        success: false,
        error: "Referral ID is invalid. Please check it and try again."
      });
    }

    // Generate a user ID that is not already in use.
    let userID = null;

    for (let i = 0; i < 30; i++) {
      const candidate = generateUserID();

      const existing = await db
        .collection("users")
        .where("userID", "==", candidate)
        .limit(1)
        .get();

      if (existing.empty) {
        userID = candidate;
        break;
      }
    }

    if (!userID) {
      return res.status(500).json({
        success: false,
        error: "Could not create a user ID. Please try again."
      });
    }

    // Firebase Authentication securely stores the password hash.
    // No email confirmation link is required by this endpoint.
    const authUser = await auth.createUser({
      email,
      password,
      displayName: name,
      emailVerified: false
    });

    createdUid = authUser.uid;

    try {
      await db.collection("users").doc(authUser.uid).set({
        uid: authUser.uid,
        userID,
        name,
        mobile,
        mobileNormalized,
        whatsapp,
        email,
        referral,
        package: packageName,
        packagePrice: PACKAGES[packageName],
        packageActive: false,
        earnings: 0,
        workEarnings: 0,
        referralEarnings: 0,
        pending: 0,
        pendingReferralCommission: 0,
        availableReferralCommission: 0,
        referralCommissionAvailableAt: null,
        nextReferralPayoutAt: null,
        directReferralCount: 0,
        level: 0,
        referralCommissionRate: 0.20,
        freePackageEligible: false,
        freePackageClaimed: false,
        emailVerified: false,
        registrationEmailVerified: false,
        registrationLinkVerified: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (error) {
      await auth.deleteUser(authUser.uid);
      createdUid = null;
      throw error;
    }

    return res.status(201).json({
      success: true,
      message: "Congratulations! Your IDWP account has been created.",
      userID,
      name,
      email,
      whatsapp,
      package: packageName
    });

  } catch (error) {
    console.error("register error:", error.code || error.message);

    if (createdUid) {
      try {
        await initFirebase().auth().deleteUser(createdUid);
      } catch (cleanupError) {
        console.error("Registration cleanup failed.");
      }
    }

    if (error.code === "auth/email-already-exists") {
      return res.status(409).json({
        success: false,
        error: "This email is already registered with IDWP."
      });
    }

    if (error.code === "auth/invalid-password") {
      return res.status(400).json({
        success: false,
        error: "The password does not meet Firebase requirements."
      });
    }

    return res.status(500).json({
      success: false,
      error: "Registration failed. Please try again."
    });
  }
};
                    
