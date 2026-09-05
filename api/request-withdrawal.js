import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function getFirebaseAdmin() {
  if (getApps().length) return getApps()[0];
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing");
  return initializeApp({ credential: cert(JSON.parse(raw)) });
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    getFirebaseAdmin();

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, error: "Login required" });
    }

    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(authHeader.slice(7));
    } catch {
      return res.status(401).json({
        success: false,
        error: "Invalid or expired login session"
      });
    }

    const { upi, amount } = req.body || {};
    const cleanUpi = String(upi || "").trim().toLowerCase();
    const withdrawalAmount = Number(amount);

    if (!/^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/.test(cleanUpi)) {
      return res.status(400).json({ success: false, error: "Invalid UPI ID" });
    }

    if (!Number.isInteger(withdrawalAmount) || withdrawalAmount < 100) {
      return res.status(400).json({
        success: false,
        error: "Minimum withdrawal amount is ₹100"
      });
    }

    const db = getFirestore();
    const userRef = db.collection("users").doc(decoded.uid);

    const withdrawalId = await db.runTransaction(async transaction => {
      const snap = await transaction.get(userRef);
      if (!snap.exists) throw new Error("User account not found");

      const user = snap.data() || {};
      const available = Number(user.earnings || 0);

      if (withdrawalAmount > available) {
        throw new Error("Insufficient available earnings");
      }

      const ref = userRef.collection("withdrawals").doc();

      transaction.set(ref, {
        uid: decoded.uid,
        upi: cleanUpi,
        amount: withdrawalAmount,
        status: "pending",
        createdAt: FieldValue.serverTimestamp()
      });

      transaction.update(userRef, {
        earnings: FieldValue.increment(-withdrawalAmount),
        pending: FieldValue.increment(withdrawalAmount)
      });

      return ref.id;
    });

    return res.status(200).json({
      success: true,
      status: "pending",
      withdrawalId,
      message: "Withdrawal request submitted for admin review."
    });
  } catch (error) {
    console.error("Withdrawal error:", error);
    return res.status(400).json({
      success: false,
      error: error.message || "Withdrawal failed"
    });
  }
}
