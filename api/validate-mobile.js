import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    })
  });
}

const db = admin.firestore();

function normalizeMobile(value) {
  let mobile = String(value || "").replace(/\D/g, "");

  // +91XXXXXXXXXX / 91XXXXXXXXXX → XXXXXXXXXX
  if (mobile.startsWith("91") && mobile.length === 12) {
    mobile = mobile.slice(2);
  }

  return mobile;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      available: false,
      error: "Method not allowed"
    });
  }

  try {
    const mobile = normalizeMobile(req.body?.mobile);

    // Indian 10-digit mobile validation
    if (!/^[6-9][0-9]{9}$/.test(mobile)) {
      return res.status(400).json({
        available: false,
        error: "Please enter a valid 10-digit mobile number."
      });
    }

    // Check whether this mobile is already registered
    const snapshot = await db
      .collection("users")
      .where("mobile", "==", mobile)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      return res.status(409).json({
        available: false,
        error:
          "This mobile number is already registered. Only one ID is allowed per mobile number."
      });
    }

    return res.status(200).json({
      available: true,
      mobile: mobile
    });

  } catch (error) {
    console.error("Mobile validation error:", error);

    return res.status(500).json({
      available: false,
      error: "Unable to verify mobile number. Please try again."
    });
  }
}
