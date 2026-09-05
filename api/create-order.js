{ getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const packages = {
  "Lead Generation": 460,
  "Commission Skill": 400,
  "Data Entry": 488,
  "Video Editing": 500,
  "Freelancing": 350,
  "Content Creation": 300
};

function getFirebaseAdmin() {
  if (getApps().length) {
    return getApps()[0];
  }

  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  );

  return initializeApp({
    credential: cert(serviceAccount)
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    getFirebaseAdmin();

    // -----------------------------
    // 1. Check Firebase Login Token
    // -----------------------------
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Login required"
      });
    }

    const idToken = authHeader.substring(7);

    let decodedToken;

    try {
      decodedToken = await getAuth().verifyIdToken(idToken);
    } catch (
