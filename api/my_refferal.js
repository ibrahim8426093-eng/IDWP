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
  res.setHeader(
    "Access-Control-Allow-Origin",
    origin || "*"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
  res.setHeader("Vary", "Origin");

  return res.end(JSON.stringify(body));
}

function getOrigin(req) {
  const origin = String(req.headers.origin || "");

  const allowed = [
    "https://idwp-nxwk.vercel.app",
    "https://ibrahim8426093-eng.github.io"
  ];

  return allowed.includes(origin) ? origin : "*";
}

function getBearerToken(req) {
  const header = String(
    req.headers.authorization || ""
  );

  return header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : "";
}

module.exports = async function handler(req, res) {
  const origin = getOrigin(req);

  if (req.method === "OPTIONS") {
    return send(res, 204, {}, origin);
  }

  if (req.method !== "GET" && req.method !== "POST") {
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

    const decoded =
      await admin.auth().verifyIdToken(token);

    const uid = decoded.uid;

    let meSnap = await db
      .collection("users")
      .doc(uid)
      .get();

    if (!meSnap.exists) {
      const byUid = await db
        .collection("users")
        .where("uid", "==", uid)
        .limit(1)
        .get();

      if (!byUid.empty) {
        meSnap = byUid.docs[0];
      }
    }

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

    // Current registration code stores
    // the referrer in `referral`.
    // `referralId` is also checked for older accounts.

    const [a, b] = await Promise.all([
      db
        .collection("users")
        .where("referral", "==", referralId)
        .limit(100)
        .get(),

      db
        .collection("users")
        .where("referralId", "==", referralId)
        .limit(100)
        .get()
    ]);

    const seen = new Set();
    const referrals = [];

    for (const snap of [a, b]) {
      for (const doc of snap.docs) {

        if (
          seen.has(doc.id) ||
          doc.id === meSnap.id
        ) {
          continue;
        }

        seen.add(doc.id);

        const u = doc.data() || {};

        referrals.push({
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
        });
      }
    }

    referrals.sort((x, y) =>
      x.name.localeCompare(y.name)
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
          "Unable to load direct referrals: " +
          (error?.message || "server error")
      },
      origin
    );
  }
};
