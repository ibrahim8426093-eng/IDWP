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

    const userRef =
      db.collection("users")
        .doc(uid);

    await db.runTransaction(
      async transaction => {

        const snap =
          await transaction.get(
            userRef
          );

        if (!snap.exists) {
          throw new Error(
            "User account not found"
          );
        }

        const user =
          snap.data() || {};

        const directPaid =
          Number(
            user.directReferralCount || 0
          );

        if (directPaid < 8) {
          throw new Error(
            `You need 8 direct paid referrals. Current: ${directPaid}/8`
          );
        }

        if (
          user.freePackageRewardClaimed ===
          true
        ) {
          throw new Error(
            "Free package has already been claimed."
          );
        }

        /*
          The free package is awarded
          without taking money from
          the client's wallet.
        */

        transaction.set(
          userRef,
          {
            freePackageReward:
              false,

            freePackageRewardClaimed:
              true,

            freePackageClaimedAt:
              admin.firestore.FieldValue
                .serverTimestamp(),

            freePackage:
              true,

            packageActive:
              true,

            freePackageSource:
              "8_DIRECT_PAID_REFERRALS",

            updatedAt:
              admin.firestore.FieldValue
                .serverTimestamp()
          },
          {
            merge: true
          }
        );
      }
    );

    return send(res, 200, {

      success: true,

      message:
        "Congratulations! Your free IDWP package has been activated.",

      freePackage:
        true,

      status:
        "CLAIMED"
    });

  } catch (error) {

    console.error(
      "Free package claim error:",
      error
    );

    return send(res, 400, {

      success: false,

      error:
        error.message ||
        "Unable to claim free package"
    });
  }
};
