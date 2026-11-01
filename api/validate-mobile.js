const { initFirebase, methodGuard } = require("../firebase-helper");

function normalizeMobile(value) {
  return String(value || "").replace(/\D/g, "").replace(/^0+/, "");
}

module.exports = async function handler(req, res) {
  if (methodGuard(req, res)) return;

  try {
    const body = req.body || {};
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

    const normalizedSnapshot = await usersRef
      .where("mobileNormalized", "==", mobile)
      .limit(1)
      .get();

    let exists = !normalizedSnapshot.empty;

    if (!exists) {
      const mobileSnapshot = await usersRef
        .where("mobile", "==", mobile)
        .limit(1)
        .get();

      exists = !mobileSnapshot.empty;
    }

    // Valid request returns HTTP 200 whether the number
    // is available or already registered.
    // Frontend will use "exists" to decide what to show.
    return res.status(200).json({
      success: !exists,
      exists,
      available: !exists,
      message: exists
        ? "This mobile number is already registered."
        : "Mobile number is available."
    });

  } catch (error) {
    console.error("validate-mobile error:", error);

    return res.status(500).json({
      success: false,
      exists: false,
      available: false,
      message: "Unable to verify mobile number right now. Please try again."
    });
  }
};
