
const crypto = require("crypto");
const { initFirebase, methodGuard } = require("../firebase-helper");

function mobile(value) {
  return String(value || "").replace(/\D/g, "");
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

module.exports = async function handler(req, res) {
  if (methodGuard(req, res)) return;

  try {
    const admin = initFirebase();
    const db = admin.firestore();

    const authorization = String(req.headers.authorization || "");
    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Please log in again."
      });
    }

    const decoded = await admin.auth().verifyIdToken(
      authorization.slice(7)
    );

    const body = req.body || {};
    const changes = body.changes || {};

    const name = String(changes.name || "").trim();
    const newMobile = mobile(changes.mobile);
    const whatsapp = mobile(changes.whatsapp);
    const newEmail = String(changes.email || "").trim().toLowerCase();

    if (name.length < 2 || name.length > 80) {
      return res.status(400).json({
        success: false,
        error: "Please enter a valid name."
      });
    }

    if (
      !/^[6-9]\d{9}$/.test(newMobile) ||
      !/^[6-9]\d{9}$/.test(whatsapp)
    ) {
      return res.status(400).json({
        success: false,
        error: "Enter valid 10-digit mobile and WhatsApp numbers."
      });
    }

    if (!validEmail(newEmail)) {
      return res.status(400).json({
        success: false,
        error: "Enter a valid email address."
      });
    }

    let userRef = db.collection("users").doc(decoded.uid);
    let userSnap = await userRef.get();

    if (!userSnap.exists) {
      const query = await db.collection("users")
        .where("uid", "==", decoded.uid)
        .limit(1)
        .get();

      if (!query.empty) {
        userRef = query.docs[0].ref;
        userSnap = query.docs[0];
      }
    }

    if (!userSnap.exists) {
      return res.status(404).json({
        success: false,
        error: "IDWP profile not found."
      });
    }

    const current = userSnap.data() || {};
    const currentEmail = String(
      current.email || decoded.email || ""
    ).trim().toLowerCase();

    if (!currentEmail) {
      return res.status(400).json({
        success: false,
        error: "Current registered email was not found."
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256")
      .update(token)
      .digest("hex");

    const pendingRef = db.collection("pendingProfileChanges")
      .doc(tokenHash);

    await pendingRef.set({
      uid: decoded.uid,
      userDocId: userRef.id,
      currentEmail,
      changes: {
        name,
        mobile: newMobile,
        mobileNormalized: newMobile,
        whatsapp,
        email: newEmail
      },
      expiresAt: Date.now() + 30 * 60 * 1000,
      used: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM_EMAIL;

    if (!apiKey || !from) {
      await pendingRef.delete();
      return res.status(500).json({
        success: false,
        error: "Email service is not configured in Vercel."
      });
    }

    const link =
      "https://ibrahim8426093-eng.github.io/IDWP/" +
      "?confirmProfileChange=" + encodeURIComponent(token);

    const safeName = name.replace(/[<>&"]/g, "");

    const emailResponse = await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from,
          to: [currentEmail],
          subject: "Confirm your IDWP profile changes",
          text:
            "Hello " + safeName + ",\n\n" +
            "You requested changes to your IDWP profile.\n" +
            "Confirm using this link within 30 minutes:\n" +
            link + "\n\n" +
            "If you did not request this, ignore this email.",
          html:
            '<div style="font-family:Arial,sans-serif;padding:24px">' +
            '<h2>Confirm IDWP profile changes</h2>' +
            '<p>Hello ' + safeName + ',</p>' +
            '<p>Click below to confirm your profile changes.</p>' +
            '<p><a href="' + link + '" ' +
            'style="background:#2563eb;color:white;padding:12px 18px;' +
            'text-decoration:none;border-radius:8px">' +
            'Confirm Changes</a></p>' +
            '<p>This link expires in 30 minutes.</p>' +
            '</div>'
        })
      }
    );

    if (!emailResponse.ok) {
      console.error(
        "Email provider error:",
        emailResponse.status,
        await emailResponse.text()
      );

      await pendingRef.delete();

      return res.status(502).json({
        success: false,
        error: "Could not send confirmation email."
      });
    }

    return res.status(200).json({
      success: true,
      message: "Confirmation link sent to your registered email."
    });
  } catch (error) {
    console.error("Profile email request error:", error);

    return res.status(500).json({
      success: false,
      error: "Could not request profile confirmation."
    });
  }
};
          
