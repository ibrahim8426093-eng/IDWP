
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

function normalizeMobile(v) {
  return String(v || "").replace(/\D/g, "");
}

function encryptPassword(password) {
  const secret = process.env.REGISTRATION_ENCRYPTION_KEY;
  if (!secret) throw new Error("REGISTRATION_ENCRYPTION_KEY is not configured.");

  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(password, "utf8"),
    cipher.final()
  ]);

  return {
    encryptedPassword: encrypted.toString("base64"),
    passwordIv: iv.toString("base64"),
    passwordTag: cipher.getAuthTag().toString("base64")
  };
}

module.exports = async function handler(req, res) {
  if (methodGuard(req, res)) return;

  try {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const mobile = normalizeMobile(body.mobile);
    const whatsapp = normalizeMobile(body.whatsappNumber);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const referral = String(body.referralId || "").trim().toUpperCase();
    const packageName = String(body.package || "").trim();

    if (!name || !email || !password || !mobile || !whatsapp || !referral || !packageName) {
      return res.status(400).json({
        success: false,
        error: "Please fill all registration fields."
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: "Enter a valid email address." });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: "Password must be at least 6 characters." });
    }

    if (!/^[6-9]\d{9}$/.test(mobile) || !/^[6-9]\d{9}$/.test(whatsapp)) {
      return res.status(400).json({
        success: false,
        error: "Enter valid 10-digit Indian mobile and WhatsApp numbers."
      });
    }

    if (!PACKAGES[packageName]) {
      return res.status(400).json({ success: false, error: "Select a valid package." });
    }

    const admin = initFirebase();
    const db = admin.firestore();

    try {
      await admin.auth().getUserByEmail(email);
      return res.status(409).json({
        success: false,
        error: "This email is already registered with IDWP."
      });
    } catch (e) {
      if (e.code !== "auth/user-not-found") throw e;
    }

    const mobileSnap = await db.collection("users")
      .where("mobileNormalized", "==", mobile).limit(1).get();

    if (!mobileSnap.empty) {
      return res.status(409).json({
        success: false,
        error: "This mobile number is already registered with IDWP."
      });
    }

    const refSnap = await db.collection("users")
      .where("userID", "==", referral).limit(1).get();

    if (refSnap.empty) {
      return res.status(400).json({
        success: false,
        error: "Referral ID was not found. Please check it and try again."
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const enc = encryptPassword(password);
    const pendingRef = db.collection("pendingEmailRegistrations").doc(tokenHash);

    await pendingRef.set({
      name, mobile, mobileNormalized: mobile, whatsapp, email, referral,
      package: packageName,
      packagePrice: PACKAGES[packageName],
      ...enc,
      expiresAt: Date.now() + 30 * 60 * 1000,
      used: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const fromEmail = process.env.RESEND_FROM_EMAIL;
    const apiKey = process.env.RESEND_API_KEY;

    if (!apiKey || !fromEmail) {
      await pendingRef.delete();
      return res.status(500).json({
        success: false,
        error: "Email service is not configured in Vercel."
      });
    }

    const link = "https://ibrahim8426093-eng.github.io/IDWP/?confirmRegistration=" +
      encodeURIComponent(token);

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        subject: "Confirm your IDWP registration",
        text: `Hello ${name},

Open this link within 30 minutes to confirm your email and continue ID creation:
${link}

If you did not request this, ignore this email.`,
        html: `<div style="font-family:Arial,sans-serif;padding:24px">
          <h2>Confirm your IDWP registration</h2>
          <p>Hello ${name.replace(/[<>&"]/g, "")},</p>
          <p>Click below to continue creating your IDWP account.</p>
          <p><a href="${link}" style="background:#2563eb;color:white;padding:12px 18px;text-decoration:none;border-radius:8px">Open confirmation page</a></p>
          <p>On the page, tap Confirm &amp; Create ID. This link expires in 30 minutes.</p>
        </div>`
      })
    });

    if (!response.ok) {
      console.error("Resend error:", response.status, await response.text());
      await pendingRef.delete();
      return res.status(502).json({
        success: false,
        error: "Verification email could not be sent. Please try again."
      });
    }

    return res.status(200).json({
      success: true,
      message: "Email verification link sent. It expires in 30 minutes."
    });
  } catch (e) {
    console.error("request-register-link error:", e);
    return res.status(500).json({
      success: false,
      error: "Could not send registration link. Please check Vercel logs."
    });
  }
};
        
