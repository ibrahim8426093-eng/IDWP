const admin = require("firebase-admin");

function getFirebaseAdmin() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

    if (!raw) {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_JSON is missing"
      );
    }

    admin.initializeApp({
      credential: admin.credential.cert(
        JSON.parse(raw)
      )
    });
  }

  return admin;
}

const FRONTEND =
  "https://ibrahim8426093-eng.github.io";

function send(res, status, body) {
  res.status(status);

  res.setHeader(
    "Content-Type",
    "application/json"
  );

  res.setHeader(
    "Access-Control-Allow-Origin",
    FRONTEND
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );

  return res.send(
    JSON.stringify(body)
  );
}

module.exports = async (req, res) => {

  if (req.method === "OPTIONS") {
    return send(res, 204, {});
  }

  if (req.method !== "POST") {
    return send(res, 405, {
      success: false,
      error: "Method not allowed"
    });
  }

  try {

    const adminApp =
      getFirebaseAdmin();

    const db =
      adminApp.firestore();

    const authHeader =
      req.headers.authorization || "";

    if (
      !authHeader.startsWith("Bearer ")
    ) {
      return send(res, 401, {
        success: false,
        error: "Login required"
      });
    }

    const decoded =
      await adminApp
        .auth()
        .verifyIdToken(
          authHeader.slice(7)
        );

    const uid =
      decoded.uid;

    const {
      withdrawalId
    } = req.body || {};

    if (!withdrawalId) {
      return send(res, 400, {
        success: false,
        error: "Withdrawal ID is required"
      });
    }

    const withdrawalRef =
      db.collection("withdrawals")
        .doc(withdrawalId);

    const snap =
      await withdrawalRef.get();

    if (!snap.exists) {
      return send(res, 404, {
        success: false,
        error: "Withdrawal not found"
      });
    }

    const withdrawal =
      snap.data();

    if (withdrawal.uid !== uid) {
      return send(res, 403, {
        success: false,
        error:
          "Withdrawal does not belong to this account"
      });
    }

    /*
      This endpoint only reads the internal
      withdrawal state.

      It DOES NOT pretend that money was
      transferred successfully.
    */

    return send(res, 200, {
      success: true,
      withdrawalId,
      amount: Number(
        withdrawal.amount || 0
      ),
      upiId:
        withdrawal.upiId || "",
      status:
        withdrawal.status || "PENDING",
      paymentProvider:
        withdrawal.paymentProvider ||
        "CASHFREE_PAYOUTS"
    });

  } catch (error) {

    console.error(
      "Payout status error:",
      error
    );

    return send(res, 500, {
      success: false,
      error:
        error.message ||
        "Unable to check payout status"
    });
  }
};
