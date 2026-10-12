
const crypto = require("crypto");
const { initFirebase, methodGuard } = require("../firebase-helper");

module.exports = async function handler(req, res) {
  if (methodGuard(req, res)) return;

  try {
    const admin = initFirebase();
    const db = admin.firestore();

    const token = String(
      (req.body && req.body.token) ||
      (req.query && req.query.token) ||
      ""
    ).trim();

    if (!/^[a-f0-9]{64}$/.test(token)) {
      return res.status(400).json({
        success: false,
        error: "Invalid confirmation link."
      });
    }

    const tokenHash = crypto.createHash("sha256")
      .update(token)
      .digest("hex");

    const pendingRef = db.collection("pendingProfileChanges")
      .doc(tokenHash);

    const pendingSnap = await pendingRef.get();

    if (!pendingSnap.exists) {
      return res.status(400).json({
        success: false,
        error: "This confirmation link is invalid or already used."
      });
    }

    const pending = pendingSnap.data();

    if (pending.used || Date.now() > Number(pending.expiresAt || 0)) {
      return res.status(400).json({
        success: false,
        error: "This confirmation link has expired or was already used."
      });
    }

    const changes = pending.changes || {};
    const userRef = db.collection("users").doc(pending.userDocId);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({
        success: false,
        error: "IDWP profile not found."
      });
    }

    const authUser = await admin.auth().getUser(pending.uid);
    const currentEmail = String(
      pending.currentEmail || ""
    ).trim().toLowerCase();

    if (
      String(authUser.email || "").trim().toLowerCase() !== currentEmail
    ) {
      return res.status(409).json({
        success: false,
        error: "Registered email has changed. Please request a new link."
      });
    }

    const newEmail = String(changes.email || "")
      .trim()
      .toLowerCase();

    if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return res.status(400).json({
        success: false,
        error: "The requested email address is invalid."
      });
    }

    const batch = db.batch();

    batch.update(userRef, {
      name: String(changes.name || "").trim(),
      fullName: String(changes.name || "").trim(),
      mobile: String(changes.mobile || ""),
      mobileNormalized: String(changes.mobileNormalized || changes.mobile || ""),
      whatsapp: String(changes.whatsapp || ""),
      email: newEmail,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    batch.delete(pendingRef);
    await batch.commit();

    if (newEmail !== currentEmail) {
      try {
        await admin.auth().updateUser(pending.uid, {
          email: newEmail,
          emailVerified: false
        });
      } catch (authError) {
        console.error("Firebase Auth email update failed:", authError);

        return res.status(500).json({
          success: false,
          error: "Profile saved, but login email update failed. Please contact support."
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: "Profile changes confirmed successfully."
    });
  } catch (error) {
    console.error("Profile confirmation error:", error);

    return res.status(500).json({
      success: false,
      error: "Could not confirm profile changes."
    });
  }
};
    
