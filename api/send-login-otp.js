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

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const { email } = req.body || {};

    if (!email) {
      return res.status(400).json({
        error: "Email is required.",
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({
        error: "Invalid email address.",
      });
    }

    // Check that the IDWP account exists
    let userRecord;

    try {
      userRecord = await admin.auth().getUserByEmail(normalizedEmail);
    } catch (err) {
      return res.status(404).json({
        error: "No IDWP account found with this email.",
      });
    }

    // Prevent OTP spam: 60-second cooldown
    const existing = await db
      .collection("loginOtps")
      .where("email", "==", normalizedEmail)
      .where("used", "==", false)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    if (!existing.empty) {
      const oldData = existing.docs[0].data();

      if (oldData.createdAt) {
        const createdTime = oldData.createdAt.toMillis();
        const secondsPassed =
          (Date.now() - createdTime) / 1000;

        if (secondsPassed < 60) {
          return res.status(429).json({
            error: `Please wait ${Math.ceil(
              60 - secondsPassed
            )} seconds before requesting another OTP.`,
          });
        }
      }
    }

    const otp = generateOTP();
    const otpHash = hashOTP(otp);

    const expiresAt = admin.firestore.Timestamp.fromMillis(
      Date.now() + 5 * 60 * 1000
    );

    await db.collection("loginOtps").add({
      email: normalizedEmail,
      uid: userRecord.uid,
      otpHash,
      used: false,
      attempts: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt,
    });

    // -------------------------------------------------
    // EMAIL SENDING
    // -------------------------------------------------
    // Resend API is used so no email package is required.
    // Add RESEND_API_KEY and RESEND_FROM_EMAIL in Vercel.
    // -------------------------------------------------

    const resendKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.RESEND_FROM_EMAIL;

    if (!resendKey || !fromEmail) {
      console.error(
        "Missing RESEND_API_KEY or RESEND_FROM_EMAIL"
      );

      return res.status(500).json({
        error: "Email service is not configured yet.",
      });
    }

    const emailResponse = await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [normalizedEmail],
          subject: "IDWP Login OTP",
          html: `
            <div style="font-family:Arial,sans-serif;max-width:500px;margin:auto">
              <h2>IDWP Login Verification</h2>

              <p>Your IDWP login OTP is:</p>

              <div style="
                font-size:32px;
                font-weight:bold;
                letter-spacing:8px;
                padding:18px;
                text-align:center;
                background:#f2f5f9;
                border-radius:10px;
              ">
                ${otp}
              </div>

              <p>This OTP is valid for <b>5 minutes</b>.</p>

              <p>
                Do not share this OTP with anyone.
              </p>

              <p>
                Regards,<br>
                <b>IDWP</b><br>
                Founder: Ibrahim
              </p>
            </div>
          `,
        }),
      }
    );

    const emailData = await emailResponse.json().catch(() => ({}));

    if (!emailResponse.ok) {
      console.error("Resend error:", emailData);

      return res.status(500).json({
        error: "Unable to send OTP email.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "OTP sent successfully.",
      expiresIn: 300,
    });

  } catch (error) {
    console.error("send-login-otp error:", error);

    return res.status(500).json({
      error: "Unable to send login OTP right now.",
    });
  }
};
