const { initFirebase, methodGuard } = require("../firebase-helper");

function normalizeMobile(value) {
  return String(value || "").replace(/\D/g, "");
}

module.exports = async function handler(req, res) {
  if (methodGuard(req, res)) return;

  try {
    const body = req.body || {};

    // Frontend ke dono possible field names support karo.
    const mobile = normalizeMobile(
      body.mobile || body.mobileNormalized
    );

    if (!/^[6-9]\d{9}$/.test(mobile)) {
      return res.status(400).json({
        success: false,
        exists: false,
        available: false,
        message: "Please enter a valid 10-digit Indian mobile number."
      });
    }

    const admin = initFirebase();
    const db = admin.firestore();

    const usersRef = db.collection("users");

    // Check the normalized mobile field first.
    const normalizedSnapshot = await usersRef
      .where("mobileNormalized", "==", mobile)
      .limit(1)
      .get();

    let exists = !normalizedSnapshot.empty;

    // Support older records that store the number in "mobile".
    if (!exists) {
      const mobileSnapshot = await usersRef
        .where("mobile", "==", mobile)
        .limit(1)
        .get();

      exists = !mobileSnapshot.empty;
    }

    return res.status(exists ? 409 : 200).json({
      success: !exists,
      exists,
      available: !exists,
      message: exists
        ? "This mobile number is already registered."
        : "Mobile number is available."
    });
  } catch (error) {
    console.error("validate-mobile error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to verify mobile number right now. Please try again."
    });
  }
};
