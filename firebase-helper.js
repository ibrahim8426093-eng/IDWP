
const admin = require("firebase-admin");

function initFirebase() {
  if (admin.apps.length) {
    return admin;
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (raw) {
    const serviceAccount = JSON.parse(raw);

    if (
      !serviceAccount.project_id ||
      !serviceAccount.client_email ||
      !serviceAccount.private_key
    ) {
      throw new Error(
        "Firebase service account JSON is missing required fields."
      );
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

    return admin;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Firebase credentials missing. Check Vercel environment variables."
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      project_id: projectId,
      client_email: clientEmail,
      private_key: privateKey.replace(/\\n/g, "\n")
    })
  });

  return admin;
}

function methodGuard(req, res) {
  const allowedOrigins = [
    "https://ibrahim8426093-eng.github.io",
    "https://idwp-nxwk.vercel.app"
  ];

  const origin = req.headers.origin || "";

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return true;
  }

  return false;
}

module.exports = {
  initFirebase,
  methodGuard
};
