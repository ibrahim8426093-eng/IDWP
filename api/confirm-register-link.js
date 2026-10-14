const { initFirebase, methodGuard } = require("../firebase-helper");
const crypto = require("crypto");

const PACKAGES = {
  "Lead Generation": 460,
  "Commission Skill": 400,
  "Data Entry": 488,
  "Video Editing": 500,
  "Freelancing": 350,
  "Content Creation": 300
};

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function decryptPassword(p) {
  const secret = process.env.REGISTRATION_ENCRYPTION_KEY;

  if (!secret) {
    throw new Error("REGISTRATION_ENCRYPTION_KEY is not configured.");
  }

  const key = crypto.createHash("sha256").update(secret).digest();

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(p.passwordIv, "base64")
  );

  decipher.setAuthTag(Buffer.from(p.passwordTag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(p.encryptedPassword, "base64")),
    decipher.final()
  ]).toString("utf8");
}

function generateUserID() {
  return "IDWP" + Math.floor(100000 + Math.random() * 900000);
}

module.exports = async function handler(req, res) {
  if (methodGuard(req, res)) return;

  let createdUid = null;

  try {
    const token = String(req.body?.token || "").trim();

    if (!/^[a-f0-9]{64}$/.test(token)) {
      return res.status(400).json({
        success: false,
        error: "Confirmation link is invalid. Request a new link."
      });
    }

    const admin = initFirebase();
    const db = admin.firestore();

    const hash = hashToken(token);
    const pendingRef = db
      .collection("pendingEmailRegistrations")
      .doc(hash);

    const pendingSnap = await pendingRef.get();

    if (!pendingSnap.exists) {
      return res.status(400).json({
        success: false,
        error: "This confirmation link is invalid or already used. Request a new link."
      });
    }

    const p = pendingSnap.data();

    if (p.used) {
      return res.status(400).json({
        success: false,
        error: "This confirmation link has already been used."
      });
    }

    if (!p.expiresAt || Number(p.expiresAt) < Date.now()) {
      await pendingRef.delete();

      return res.status(410).json({
        success: false,
        error: "This confirmation link has expired. Please register again."
      });
    }

    if (
      !p.email ||
      !p.name ||
      !p.mobileNormalized ||
      !p.whatsapp ||
      !p.referral ||
      !PACKAGES[p.package]
    ) {
      return res.status(400).json({
        success: false,
        error: "Registration details are incomplete. Please register again."
      });
    }

    try {
      await admin.auth().getUserByEmail(p.email);

      return res.status(409).json({
        success: false,
        error: "This email is already registered with IDWP."
      });
    } catch (e) {
      if (e.code !== "auth/user-not-found") throw e;
    }

    const mobileSnap = await db
      .collection("users")
      .where("mobileNormalized", "==", p.mobileNormalized)
      .limit(1)
      .get();

    if (!mobileSnap.empty) {
      return res.status(409).json({
        success: false,
        error: "This mobile number is already registered with IDWP."
      });
    }

    const referralSnap = await db
      .collection("users")
      .where("userID", "==", p.referral)
      .limit(1)
      .get();

    if (referralSnap.empty) {
      return res.status(400).json({
        success: false,
        error: "Referral ID is no longer valid. Please contact IDWP Support."
      });
    }

    let userID = null;

    for (let i = 0; i < 20; i++) {
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
        error: "Could not generate a unique IDWP User ID. Please try again."
      });
    }

    const password = decryptPassword(p);

    const authUser = await admin.auth().createUser({
      email: p.email,
      password,
      displayName: p.name,
      emailVerified: true
    });

    createdUid = authUser.uid;

    try {
      await db.collection("users").doc(authUser.uid).set({
        uid: authUser.uid,
        userID,
        name: p.name,
        mobile: p.mobile,
        mobileNormalized: p.mobileNormalized,
        whatsapp: p.whatsapp,
        email: p.email,
        referral: p.referral,
        package: p.package,
        packagePrice: PACKAGES[p.package],
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
        emailVerified: true,
        registrationEmailVerified: true,
        registrationLinkVerified: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) {
      try {
        await admin.auth().deleteUser(authUser.uid);
      } catch (cleanup) {
        console.error("Auth cleanup failed", cleanup.message);
      }

      createdUid = null;
      throw e;
    }

    await pendingRef.delete();

    return res.status(200).json({
      success: true,
      message: "Email confirmed and IDWP account created.",
      userID,
      name: p.name,
      whatsapp: p.whatsapp,
      package: p.package,
      email: p.email
    });

  } catch (e) {
    console.error("confirm-register-link error:", e.message);

    if (createdUid) {
      try {
        await initFirebase().auth().deleteUser(createdUid);
      } catch (cleanup) {
        console.error("Auth cleanup failed", cleanup.message);
      }
    }

    return res.status(500).json({
      success: false,
      error: "Unable to complete registration right now. Please try again."
    });
  }
};
