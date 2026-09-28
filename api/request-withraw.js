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

function getOrigin(req) {
  const origin =
    req.headers.origin || "";

  if (
    origin === FRONTEND ||
    origin === "https://idwp-nxwk.vercel.app"
  ) {
    return origin;
  }

  return FRONTEND;
}

function send(res, status, body, origin) {
  res.status(status);

  res.setHeader(
    "Content-Type",
    "application/json"
  );

  res.setHeader(
    "Access-Control-Allow-Origin",
    origin
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );

  res.setHeader(
    "Vary",
    "Origin"
  );

  return res.send(
    JSON.stringify(body)
  );
}

module.exports = async (req, res) => {

  const origin =
    getOrigin(req);

  if (req.method === "OPTIONS") {
    return send(
      res,
      204,
      {},
      origin
    );
  }

  if (req.method !== "POST") {
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

    const adminApp =
      getFirebaseAdmin();

    const db =
      adminApp.firestore();

    const authHeader =
      req.headers.authorization || "";

    if (
      !authHeader.startsWith("Bearer ")
    ) {
      return send(
        res,
        401,
        {
          success: false,
          error: "Login required"
        },
        origin
      );
    }

    const token =
      authHeader.slice(7);

    const decoded =
      await adminApp
        .auth()
        .verifyIdToken(token);

    const uid =
      decoded.uid;

    const {
      amount,
      upiId,
      upi
    } = req.body || {};

    const withdrawalAmount =
      Number(amount);

    const finalUpi =
      String(
        upiId || upi || ""
      )
        .trim()
        .toLowerCase();

    /*
      UPI validation
    */
    if (
      !finalUpi ||
      !/^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/
        .test(finalUpi)
    ) {
      return send(
        res,
        400,
        {
          success: false,
          error: "Valid UPI ID is required"
        },
        origin
      );
    }

    /*
      Minimum withdrawal:
      ₹100
    */
    if (
      !Number.isInteger(
        withdrawalAmount
      ) ||
      withdrawalAmount < 100
    ) {
      return send(
        res,
        400,
        {
          success: false,
          error:
            "Minimum withdrawal amount is ₹100"
        },
        origin
      );
    }

    const userRef =
      db.collection("users")
        .doc(uid);

    const withdrawalRef =
      db.collection("withdrawals")
        .doc();

    /*
      Keep user's own withdrawal history
      as well as global withdrawal record.
    */
    const userWithdrawalRef =
      userRef
        .collection("withdrawals")
        .doc(withdrawalRef.id);

    const result =
      await db.runTransaction(
        async transaction => {

          const userSnap =
            await transaction.get(
              userRef
            );

          if (!userSnap.exists) {
            throw new Error(
              "User account not found"
            );
          }

          const user =
            userSnap.data() || {};

          /*
            Earnings already credited
            through the IDWP wallet.
          */
          const earnings =
            Number(
              user.earnings ||
              user.totalEarnings ||
              0
            );

          const withdrawn =
            Number(
              user.withdrawn || 0
            );

          const pending =
            Number(
              user.pendingWithdrawal ||
              0
            );

          /*
            Money currently available
            for withdrawal.
          */
          const available =
            earnings -
            withdrawn -
            pending;

          if (
            withdrawalAmount >
            available
          ) {
            throw new Error(
              `Insufficient balance. Available: ₹${available.toFixed(2)}`
            );
          }

          const withdrawalData = {

            withdrawalId:
              withdrawalRef.id,

            uid,

            userID:
              user.userID || "",

            amount:
              withdrawalAmount,

            upiId:
              finalUpi,

            status:
              "PENDING",

            paymentProvider:
              "CASHFREE_PAYOUTS",

            createdAt:
              admin.firestore.FieldValue
                .serverTimestamp(),

            updatedAt:
              admin.firestore.FieldValue
                .serverTimestamp()
          };

          /*
            Global withdrawal record
          */
          transaction.set(
            withdrawalRef,
            withdrawalData
          );

          /*
            User withdrawal history
          */
          transaction.set(
            userWithdrawalRef,
            withdrawalData
          );

          /*
            Reserve the amount so the
            same money cannot be withdrawn
            twice.
          */
          transaction.set(
            userRef,
            {
              pendingWithdrawal:
                pending +
                withdrawalAmount,

              updatedAt:
                admin.firestore.FieldValue
                  .serverTimestamp()
            },
            {
              merge: true
            }
          );

          return {

            withdrawalId:
              withdrawalRef.id,

            amount:
              withdrawalAmount,

            availableAfterRequest:
              available -
              withdrawalAmount
          };
        }
      );

    return send(
      res,
      200,
      {

        success: true,

        message:
          "Withdrawal request submitted. It will be paid through Cashfree Payouts after payout processing.",

        withdrawalId:
          result.withdrawalId,

        amount:
          result.amount,

        availableAfterRequest:
          result.availableAfterRequest,

        status:
          "PENDING"
      },
      origin
    );

  } catch (error) {

    console.error(
      "Withdrawal request error:",
      error
    );

    return send(
      res,
      400,
      {
        success: false,
        error:
          error.message ||
          "Withdrawal request failed"
      },
      origin
    );
  }
};
