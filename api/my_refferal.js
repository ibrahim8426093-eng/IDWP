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
    "GET, OPTIONS"
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

function getBearerToken(req) {
  const header = String(req.headers.authorization || "");

  if (!header.startsWith("Bearer ")) {
    return "";
  }

  return header.slice(7).trim();
}

module.exports = async function handler(req, res) {
  const origin = getOrigin(req);

  if (req.method === "OPTIONS") {
    return send(res, 204, {}, origin);
  }

  if (req.method !== "GET") {
    return send(
      res,
      405,
      {
        success: false,
        error: "Method not allowed"
      },
      origin
    );
  }

  try {
    const token = getBearerToken(req);

    if (!token) {
      return send(
        res,
        401,
        {
          success: false,
          error: "Authentication required."
        },
        origin
      );
    }

    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;

    const meSnap = await db
      .collection("users")
      .doc(uid)
      .get();

    if (!meSnap.exists) {
      return send(
        res,
        404,
        {
          success: false,
          error: "User profile not found."
        },
        origin
      );
    }

    const me = meSnap.data() || {};

    const referralId = String(
      me.userID || ""
    )
      .trim()
      .toUpperCase();

    if (!referralId) {
      return send(
        res,
        200,
        {
          success: true,
          referralId: "",
          count: 0,
          referrals: []
        },
        origin
      );
    }

    const snap = await db
      .collection("users")
      .where("referral", "==", referralId)
      .limit(100)
      .get();

    const referrals = snap.docs
      .map(doc => {
        const u = doc.data() || {};

        return {
          name: String(
            u.name || "IDWP User"
          ),

          userID: String(
            u.userID || "-"
          ),

          package: String(
            u.package ||
            u.skill ||
            "-"
          ),

          packageActive: Boolean(
            u.packageActive ||
            u.packageStatus === "active"
          )
        };
      })
      .sort((a, b) =>
        a.name.localeCompare(b.name)
      );

    return send(
      res,
      200,
      {
        success: true,
        referralId,
        count: referrals.length,
        referrals
      },
      origin
    );

  } catch (error) {
    console.error(
      "my-referrals error:",
      error
    );

    return send(
      res,
      500,
      {
        success: false,
        error:
          "Unable to load direct referrals. Please try again."
      },
      origin
    );
  }
};
