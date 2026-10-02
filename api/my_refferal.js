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

function send(res, status, body, origin = "*") {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
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
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return null;
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

    // Verify logged-in Firebase user
    const decoded = await admin.auth().verifyIdToken(token);

    const uid = decoded.uid;

    // Get current user's profile
    const currentUserSnap = await db
      .collection("users")
      .doc(uid)
      .get();

    if (!currentUserSnap.exists) {
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

    const currentUser = currentUserSnap.data() || {};
    const userID = String(currentUser.userID || "")
      .trim()
      .toUpperCase();

    if (!userID) {
      return send(
        res,
        400,
        {
          success: false,
          error: "Your User ID is missing."
        },
        origin
      );
    }

    // Find users whose referral field is this user's User ID
    const snapshot = await db
      .collection("users")
      .where("referral", "==", userID)
      .get();

    const referrals = snapshot.docs.map(doc => {
      const data = doc.data() || {};

      return {
        uid: doc.id,
        userID: data.userID || "-",
        name: data.name || "-",
        email: data.email || "",
        mobile: data.mobile || "",
        whatsapp: data.whatsapp || "",
        package: data.package || "-",
        packagePrice: Number(data.packagePrice || 0),
        packageActive: Boolean(data.packageActive),
        earnings: Number(data.earnings || 0),
        referralEarnings: Number(data.referralEarnings || 0),
        createdAt: data.createdAt || null
      };
    });

    // Newest registrations first when createdAt is available
    referrals.sort((a, b) => {
      const aTime = a.createdAt?.toMillis
        ? a.createdAt.toMillis()
        : 0;

      const bTime = b.createdAt?.toMillis
        ? b.createdAt.toMillis()
        : 0;

      return bTime - aTime;
    });

    return send(
      res,
      200,
      {
        success: true,
        referralId: userID,
        count: referrals.length,
        referrals
      },
      origin
    );

  } catch (error) {
    console.error("my-referrals error:", error);

    if (
      error.code === "auth/id-token-expired" ||
      error.code === "auth/argument-error" ||
      error.code === "auth/invalid-id-token"
    ) {
      return send(
        res,
        401,
        {
          success: false,
          error: "Login session expired. Please login again."
        },
        origin
      );
    }

    return send(
      res,
      500,
      {
        success: false,
        error: "Unable to load referral list."
      },
      origin
    );
  }
};
