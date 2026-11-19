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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

function bearer(req) {
  const h = String(req.headers.authorization || "");

  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

function variants(id) {
  const s = String(id || "").trim();

  return [...new Set([
    s,
    s.toUpperCase(),
    s.toLowerCase()
  ].filter(Boolean))];
}

module.exports = async function handler(req, res) {
  const origin = getOrigin(req);

  if (req.method === "OPTIONS") {
    return send(res, 204, {}, origin);
  }

  if (!["GET", "POST"].includes(req.method)) {
    return send(res, 405, {
      success: false,
      error: "Method not allowed"
    }, origin);
  }

  try {
    const token = bearer(req);

    if (!token) {
      return send(res, 401, {
        success: false,
        error: "Authentication required."
      }, origin);
    }

    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;

    let meSnap = await db.collection("users").doc(uid).get();

    if (!meSnap.exists) {
      const byUid = await db.collection("users")
        .where("uid", "==", uid)
        .limit(1)
        .get();

      if (!byUid.empty) {
        meSnap = byUid.docs[0];
      }
    }

    if (!meSnap.exists) {
      return send(res, 404, {
        success: false,
        error: "User profile not found."
      }, origin);
    }

    const me = meSnap.data() || {};

    const referralId = String(me.userID || "")
      .trim()
      .toUpperCase();

    if (!referralId) {
      return send(res, 200, {
        success: true,
        referralId: "",
        count: 0,
        referrals: []
      }, origin);
    }

    const searchValues = variants(referralId);

    const queries = [
      db.collection("users")
        .where("referral", "in", searchValues)
        .limit(100),

      db.collection("users")
        .where("referralId", "in", searchValues)
        .limit(100),

      db.collection("users")
        .where("referralCode", "in", searchValues)
        .limit(100)
    ];

    const snaps = await Promise.all(
      queries.map(q => q.get())
    );

    const seen = new Set();
    const referrals = [];

    for (const snap of snaps) {
      for (const doc of snap.docs) {
        if (seen.has(doc.id) || doc.id === meSnap.id) {
          continue;
        }

        const u = doc.data() || {};

        const recordedReferral = String(
          u.referral ||
          u.referralId ||
          u.referralCode ||
          ""
        ).trim().toUpperCase();

        if (recordedReferral !== referralId) {
          continue;
        }

        seen.add(doc.id);

        referrals.push({
          name: String(u.name || "IDWP User"),
          userID: String(u.userID || "-"),
          package: String(u.package || u.skill || "-"),
          packageActive: Boolean(
            u.packageActive ||
            String(u.packageStatus || "").toLowerCase() === "active"
          )
        });
      }
    }

    referrals.sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    return send(res, 200, {
      success: true,
      referralId,
      count: referrals.length,
      referrals
    }, origin);

  } catch (error) {
    console.error("my-referrals error:", error);

    return send(res, 500, {
      success: false,
      error: "Unable to load direct referrals: " +
        (error?.message || "server error")
    }, origin);
  }
};
