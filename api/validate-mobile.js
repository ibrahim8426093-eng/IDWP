m
const { initFirebase, methodGuard } = require("../firebase-helper");

function normalizeMobile(value) {
  return String(value || "").replace(/\D/g, "");
}

function isValidIndianMobile(mobile) {
  return /^[6-9]\d{9}$/.test(mobile);
}

module.exports = async function handler(req, res) {
  if (methodGuard(req, res)) return;

  try {
    const mobile = normalizeMobile(req.body?.mobile);

    if (!isValidIndianMobile(mobile)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid 10-digit Indian mobile number."
      });
    }

    const admin = initFirebase();
    const db = admin.firestore();

    const snapshot = await db
      .collection("users")
      .where("mobile", "==", mobile)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      return res.status(409).json({
        success: false,
        available: false,
        message: "This mobile number is already registered."
      });
    }

    return res.status(200).json({
      success: true,
      available: true,
      message: "Mobile number is available."
    });
  } catch (error) {
    console.error("validate-mobile error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Server error while validating mobile number."
    });
  }
};
