
const { initFirebase, methodGuard } = require("../firebase-helper");
const crypto = require("crypto");

module.exports = async function handler(req, res) {
  if (methodGuard(req, res)) return;

  try {
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address."
      });
    }

    const apiKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.RESEND_FROM_EMAIL;

    if (!apiKey || !fromEmail) {
      console.error("Resend environment variables are missing.");

      return res.status(500).json({
        success: false,
        message: "Email service is not configured."
      });
    }

    const admin = initFirebase();
    const db = admin.firestore();

    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpHash = crypto
      .createHash("sha256")
      .update(otp)
      .digest("hex");

    const expiresAt = Date.now() + 5 * 60 * 1000;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        subject: "Your IDWP registration OTP",
        text: `Your registration OTP is ${otp}. It expires in 5 minutes. Do not share this code with anyone.`
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Resend API error:", response.status, errorText);

      return res.status(502).json({
        success: false,
        message: "OTP email could not be sent. Please try again."
      });
    }

    await db.collection("registrationOtps").doc(email).set({
      otpHash,
      expiresAt,
      verified: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.status(200).json({
      success: true,
      message: "OTP sent to your email. It expires in 5 minutes."
    });
  } catch (error) {
    console.error("send-register-otp error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Server error while sending OTP."
    });
  }
};
