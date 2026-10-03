const admin = require("firebase-admin");

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured");
  }

  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw))
  });
}

const db = admin.firestore();

function send(res, status, body, origin) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );
  res.setHeader("Vary", "Origin");

  return res.end(JSON.stringify(body));
}

function getOrigin(req) {
  const origin = req.headers.origin || "";

  const allowed = [
    "https://idwp-nxwk.vercel.app",
    "https://ibrahim8426093-eng.github.io"
  ];

  return allowed.includes(origin) ? origin : "*";
}

module.exports = async function handler(req, res) {
  const origin = getOrigin(req);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return send(res, 204, {}, origin);
  }

  // Only POST allowed
  if (req.method !== "POST") {
    return send(
      res,
      405,
      {
        valid: false,
        error: "Method not allowed"
      },
      origin
    );
  }

  try {
    const referralId = String(
      req.body?.referralId || ""
    )
      .trim()
      .toUpperCase();

    if (!referralId) {
      return send(
        res,
        400,
        {
          valid: false,
          error: "Referral ID is required."
        },
        origin
      );
    }

    // Search users collection using Firebase Admin.
    // This bypasses client-side Firestore permission problems.
    const snapshot = await db
      .collection("users")
      .where("userID", "==", referralId)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return send(
        res,
        200,
        {
          valid: false,
          error: "Invalid Referral ID. Please enter an existing IDWP Referral ID."
        },
        origin
      );
    }

    const refUser = snapshot.docs[0].data() || {};

    return send(
      res,
      200,
      {
        valid: true,
        referralId,
        userID: refUser.userID || referralId
      },
      origin
    );

  } catch (error) {
    console.error("validate-referral error:", error);

    return send(
      res,
      500,
      {
        valid: false,
        error: "Unable to verify Referral ID. Please try again."
      },
      origin
    );
  }
};
