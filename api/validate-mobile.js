const { initFirebase, methodGuard } = require("../firebase-helper");

function normalizeMobile(value) {
  let n = String(value || "").replace(/\D/g, "");

  // +91 / 91 country code remove
  if (n.startsWith("0091") && n.length === 14) {
    n = n.slice(4);
  } else if (n.startsWith("91") && n.length === 12) {
    n = n.slice(2);
  } else if (n.startsWith("0") && n.length === 11) {
    n = n.slice(1);
  }

  return n;
}

module.exports = async function handler(req, res) {
  if (methodGuard(req, res)) return;

  try {
    const body = req.body || {};

    const mobile = normalizeMobile(
      body.mobile || body.mobileNormalized
    );

    // Validate Indian mobile number
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

    // Check normalized mobile field
    const normalizedSnapshot = await usersRef
      .where("mobileNormalized", "==", mobile)
      .limit(1)
      .get();

    let exists = !normalizedSnapshot.empty;

    // Check old mobile field
    if (!exists) {
      const possibleNumbers = [
        mobile,
        "91" + mobile,
        "+91" + mobile,
        "0" + mobile,
        "0091" + mobile
      ];

      for (const number of possibleNumbers) {
        const snapshot = await usersRef
          .where("mobile", "==", number)
          .limit(1)
          .get();

        if (!snapshot.empty) {
          exists = true;
          break;
        }
      }
    }

    // Keep HTTP 409 for duplicate numbers.
    // Current IDWP HTML already handles this response.
    return res.status(exists ? 409 : 200).json({
      success: !exists,
      exists: exists,
      available: !exists,
      message: exists
        ? "This mobile number is already registered with IDWP."
        : "Mobile number is available."
    });

  } catch (error) {
    console.error(
      "Validate mobile error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      exists: false,
      available: false,
      message: "Unable to verify mobile number. Please try again."
    });
  }
};
