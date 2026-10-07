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

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalizeMobile(value) {
  return String(value || "").replace(/\D/g, "");
}

function validIndianMobile(value) {
  return /^[6-9]\d{9}$/.test(value);
}

/*
  Password is encrypted temporarily until OTP verification.
  The encryption key must be stored only in Vercel Environment Variables.
*/
function encryptPassword(password) {
  const keyText = process.env.REGISTRATION_ENCRYPTION_KEY;

  if (!keyText) {
    throw new Error("REGISTRATION_ENCRYPTION_KEY is not configured.");
  }

  const key = crypto
    .createHash("sha256")
    .update(keyText)
    .digest();

  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(password, "utf8"),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return {
    encrypted: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const {
      name,
      mobile,
      whatsappNumber,
      email,
      password,
      referralId,
      package: packageName,
    } = req.body || {};

    // -----------------------------
    // Basic validation
    // -----------------------------

    if (
      !name ||
      !mobile ||
      !whatsappNumber ||
      !email ||
      !password ||
      !referralId ||
      !packageName
    ) {
      return res.status(400).json({
        error: "All registration fields are required.",
      });
    }

    const cleanName = String(name).trim();
    const cleanMobile = normalizeMobile(mobile);
    const cleanWhatsApp = normalizeMobile(whatsappNumber);
    const cleanEmail = String(email).trim().toLowerCase();
    const cleanReferral = String(referralId)
      .trim()
      .toUpperCase();

    if (!validIndianMobile(cleanMobile)) {
      return res.status(400).json({
        error:
          "Mobile number must be a valid 10-digit Indian mobile number.",
      });
    }

    if (!validIndianMobile(cleanWhatsApp)) {
      return res.status(400).json({
        error:
          "WhatsApp number must be a valid 10-digit Indian mobile number.",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters.",
      });
    }

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)
    ) {
      return res.status(400).json({
        error: "Invalid email address.",
      });
    }

    if (!PACKAGES[packageName]) {
      return res.status(400).json({
        error: "Invalid package selected.",
      });
    }

    // -----------------------------
    // Check email already registered
    // -----------------------------

    try {
      await admin.auth().getUserByEmail(cleanEmail);

      return res.status(409).json({
        error:
          "This email is already registered with IDWP.",
      });
    } catch (error) {
      // auth/user-not-found is expected.
    }

    // -----------------------------
    // Check mobile uniqueness
    // -----------------------------

    const mobileSnap = await db
      .collection("users")
      .where("mobileNormalized", "==", cleanMobile)
      .limit(1)
      .get();

    if (!mobileSnap.empty) {
      return res.status(409).json({
        error:
          "This mobile number is already registered with IDWP. One mobile number can have only one ID.",
      });
    }

    // -----------------------------
    // Validate referral ID
    // -----------------------------

    const referralSnap = await db
      .collection("users")
      .where("userID", "==", cleanReferral)
      .limit(1)
      .get();

    if (referralSnap.empty) {
      return res.status(400).json({
        error: "Invalid Referral ID.",
      });
    }

    // -----------------------------
    // OTP cooldown
    // -----------------------------

    const existing = await db
      .collection("registrationOtps")
      .where("email", "==", cleanEmail)
      .where("used", "==", false)
      .get();

    let latest = null;

    existing.forEach((doc) => {
      const data = doc.data();

      if (!latest) {
        latest = doc;
        return;
      }

      const current =
        data.createdAt?.toMillis?.() || 0;

      const previous =
        latest.data().createdAt?.toMillis?.() || 0;

      if (current > previous) {
        latest = doc;
      }
    });

    if (latest) {
      const created =
        latest.data().createdAt?.toMillis?.() || 0;

      const seconds =
        (Date.now() - created) / 1000;

      if (seconds < 60) {
        return res.status(429).json({
          error: `Please wait ${Math.ceil(
            60 - seconds
          )} seconds before requesting another OTP.`,
        });
      }
    }

    // -----------------------------
    // Generate OTP
    // -----------------------------

    const otp = generateOTP();
    const otpHash = hashOTP(otp);

    const expiresAt =
      admin.firestore.Timestamp.fromMillis(
        Date.now() + 5 * 60 * 1000
      );

    // Encrypt password temporarily.
    const encryptedPassword =
      encryptPassword(password);

    // -----------------------------
    // Save pending registration
    // -----------------------------

    await db.collection("registrationOtps").add({
      name: cleanName,
      mobile: cleanMobile,
      mobileNormalized: cleanMobile,
      whatsapp: cleanWhatsApp,
      email: cleanEmail,

      encryptedPassword:
        encryptedPassword.encrypted,

      passwordIv:
        encryptedPassword.iv,

      passwordTag:
        encryptedPassword.tag,

      referral: cleanReferral,

      package: packageName,
      packagePrice: PACKAGES[packageName],

      otpHash,

      attempts: 0,
      used: false,

      createdAt:
        admin.firestore.FieldValue.serverTimestamp(),

      expiresAt,
    });

    // -----------------------------
    // Email service
    // -----------------------------

    const resendKey =
      process.env.RESEND_API_KEY;

    const fromEmail =
      process.env.RESEND_FROM_EMAIL;

    if (!resendKey || !fromEmail) {
      console.error(
        "Missing RESEND_API_KEY or RESEND_FROM_EMAIL"
      );

      return res.status(500).json({
        error:
          "Email OTP service is not configured yet.",
      });
    }

    const emailResponse = await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${resendKey}`,

          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          from: fromEmail,

          to: [cleanEmail],

          subject:
            "IDWP Registration OTP",

          html: `
<!DOCTYPE html>
<html>
<body style="
  font-family:Arial,sans-serif;
  background:#f5f7fb;
  padding:25px;
">

<div style="
  max-width:500px;
  margin:auto;
  background:white;
  padding:25px;
  border-radius:14px;
">

<h2>IDWP Registration Verification</h2>

<p>Hello <b>${cleanName}</b>,</p>

<p>
Your IDWP registration OTP is:
</p>

<div style="
  font-size:34px;
  font-weight:bold;
  letter-spacing:9px;
  text-align:center;
  padding:18px;
  background:#f1f5f9;
  border-radius:10px;
">
${otp}
</div>

<p>
This OTP is valid for <b>5 minutes</b>.
</p>

<p>
Your IDWP account/ID will be created only after
successful OTP verification.
</p>

<p>
<b>Do not share this OTP with anyone.</b>
</p>

<hr>

<p>
IDWP — Digital Work & Earn<br>
Founder: Ibrahim
</p>

</div>

</body>
</html>
          `,
        }),
      }
    );

    const emailData =
      await emailResponse
        .json()
        .catch(() => ({}));

    if (!emailResponse.ok) {
      console.error(
        "Resend error:",
        emailData
      );

      return res.status(500).json({
        error:
          "Unable to send registration OTP email.",
      });
    }

    return res.status(200).json({
      success: true,
      message:
        "Registration OTP sent successfully.",
      expiresIn: 300,
    });

  } catch (error) {
    console.error(
      "send-register-otp error:",
      error
    );

    return res.status(500).json({
      error:
        "Unable to send registration OTP right now.",
    });
  }
};
