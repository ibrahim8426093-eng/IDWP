const admin = require("firebase-admin");

function getFirebaseAdmin() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

    if (!raw) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing");
    }

    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw))
    });
  }

  return admin;
}

const FRONTEND =
  "https://ibrahim8426093-eng.github.io";

function getOrigin(req) {
  const o = req.headers.origin || "";

  if (
    o === FRONTEND ||
    o === "https://idwp-nxwk.vercel.app"
  ) {
    return o;
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

  res.setHeader("Vary", "Origin");

  return res.send(JSON.stringify(body));
}

function getToken(req) {
  const h =
    req.headers.authorization || "";

  if (!h.startsWith("Bearer ")) {
    return null;
  }

  return h.slice(7);
}

/*
  Direct referral commission rate
  depends on DIRECT PAID REFERRALS.
*/
function directRate(level) {
  level = Number(level || 0);

  if (level >= 51) return 0.50;
  if (level >= 31) return 0.48;
  if (level >= 26) return 0.45;
  if (level >= 16) return 0.43;
  if (level >= 11) return 0.40;
  if (level >= 9) return 0.35;
  if (level >= 5) return 0.30;

  return 0.20;
}

/*
  Generation commission
*/
const generationRates = [
  0,
  0.20,
  0.15,
  0.05,
  0.03,
  0.02
];

module.exports = async (req, res) => {

  const origin = getOrigin(req);

  if (req.method === "OPTIONS") {
    return send(res, 204, {}, origin);
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

    const token =
      getToken(req);

    if (!token) {
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

    const decoded =
      await adminApp
        .auth()
        .verifyIdToken(token);

    const uid = decoded.uid;

    const orderId =
      String(
        req.body?.orderId || ""
      ).trim();

    if (!orderId) {
      return send(
        res,
        400,
        {
          success: false,
          error: "Order ID is required"
        },
        origin
      );
    }

    const orderRef =
      db.collection("orders")
        .doc(orderId);

    const orderSnap =
      await orderRef.get();

    if (!orderSnap.exists) {
      return send(
        res,
        404,
        {
          success: false,
          error: "Order not found"
        },
        origin
      );
    }

    const order =
      orderSnap.data();

    if (order.uid !== uid) {
      return send(
        res,
        403,
        {
          success: false,
          error:
            "Order does not belong to this account"
        },
        origin
      );
    }

    /*
      Already processed order
      prevents duplicate commissions.
    */
    if (
      String(order.status || "")
        .toLowerCase() === "paid"
    ) {
      return send(
        res,
        200,
        {
          success: true,
          alreadyProcessed: true,
          status: "paid",
          orderId
        },
        origin
      );
    }

    const clientId =
      String(
        process.env.CASHFREE_CLIENT_ID || ""
      ).trim();

    const clientSecret =
      String(
        process.env.CASHFREE_CLIENT_SECRET || ""
      ).trim();

    if (!clientId || !clientSecret) {
      return send(
        res,
        503,
        {
          success: false,
          error:
            "Cashfree is not configured on this deployment."
        },
        origin
      );
    }

    const environment =
      String(
        process.env.CASHFREE_ENVIRONMENT ||
        order.environment ||
        "production"
      )
        .trim()
        .toLowerCase();

    const baseUrl =
      environment === "sandbox"
        ? "https://sandbox.cashfree.com"
        : "https://api.cashfree.com";

    /*
      Check actual Cashfree order status.
    */
    const response =
      await fetch(
        baseUrl +
          "/pg/orders/" +
          encodeURIComponent(orderId),
        {
          method: "GET",

          headers: {
            Accept: "application/json",
            "x-api-version": "2025-01-01",
            "x-client-id": clientId,
            "x-client-secret": clientSecret,
            "x-request-id": orderId
          }
        }
      );

    const data =
      await response
        .json()
        .catch(() => ({}));

    if (!response.ok) {
      console.error(
        "Cashfree verification error:",
        response.status,
        data
      );

      return send(
        res,
        response.status,
        {
          success: false,
          error:
            data.message ||
            "Unable to verify Cashfree order"
        },
        origin
      );
    }

    const cashfreeStatus =
      String(
        data.order_status || ""
      ).toUpperCase();

    /*
      Payment is NOT paid.
      Therefore:
      - no commission
      - no level increase
      - no free package
    */
    if (cashfreeStatus !== "PAID") {

      await orderRef.update({
        status:
          cashfreeStatus.toLowerCase() ||
          "pending",

        updatedAt:
          admin.firestore.FieldValue
            .serverTimestamp()
      });

      return send(
        res,
        200,
        {
          success: false,
          paid: false,
          status: "pending",
          gatewayStatus:
            cashfreeStatus || "PENDING",
          message:
            "Payment is not marked PAID yet."
        },
        origin
      );
    }

    const userRef =
      db.collection("users")
        .doc(uid);

    let commissionTotal = 0;

    let freePackageAwarded = false;

    /*
      All payment/referral changes are done
      inside one Firestore transaction.
    */
    await db.runTransaction(
      async transaction => {

        const latestOrderSnap =
          await transaction.get(orderRef);

        if (!latestOrderSnap.exists) {
          throw new Error(
            "Order not found"
          );
        }

        const latestOrder =
          latestOrderSnap.data();

        /*
          Prevent duplicate processing.
        */
        if (
          String(
            latestOrder.status || ""
          ).toLowerCase() === "paid"
        ) {
          return;
        }

        const buyerSnap =
          await transaction.get(userRef);

        if (!buyerSnap.exists) {
          throw new Error(
            "User account not found"
          );
        }

        const buyer =
          buyerSnap.data() || {};

        const amount =
          Number(
            latestOrder.amount || 0
          );

        const packageName =
          latestOrder.packageName ||
          latestOrder.package ||
          "";

        /*
          --------------------------------
          REFERRAL CHAIN
          --------------------------------

          Buyer must have a referral.
          Only PAID package purchase creates
          commission.
        */

        const chain = [];

        let nextUserId =
          buyer.referral
            ? String(
                buyer.referral
              )
                .trim()
                .toUpperCase()
            : null;

        const buyerUserId =
          String(
            buyer.userID || ""
          ).toUpperCase();

        const seen =
          new Set(
            buyerUserId
              ? [buyerUserId]
              : []
          );

        /*
          Maximum 5 generations.
        */
        for (
          let generation = 1;
          generation <= 5 && nextUserId;
          generation++
        ) {

          if (
            seen.has(nextUserId)
          ) {
            break;
          }

          seen.add(nextUserId);

          const q =
            await transaction.get(
              db.collection("users")
                .where(
                  "userID",
                  "==",
                  nextUserId
                )
                .limit(1)
            );

          if (q.empty) {
            break;
          }

          const refDoc =
            q.docs[0];

          const refUser =
            refDoc.data() || {};

          chain.push({
            generation,
            refDoc,
            refUser
          });

          nextUserId =
            refUser.referral
              ? String(
                  refUser.referral
                )
                  .trim()
                  .toUpperCase()
              : null;
        }

        /*
          --------------------------------
          ACTIVATE BUYER PACKAGE
          --------------------------------
        */

        transaction.update(
          userRef,
          {
            package:
              packageName,

            packagePrice:
              amount,

            packageAmount:
              amount,

            packageActive:
              true,

            packageOrderId:
              orderId,

            packageActivatedAt:
              admin.firestore.FieldValue
                .serverTimestamp(),

            updatedAt:
              admin.firestore.FieldValue
                .serverTimestamp()
          }
        );

        /*
          --------------------------------
          PAY REFERRAL COMMISSIONS
          --------------------------------
        */

        for (const item of chain) {

          const ref =
            item.refDoc.ref;

          const current =
            item.refUser;

          const oldLevel =
            Number(
              current.level || 0
            );

          const paidList =
            Array.isArray(
              current.paidDirectReferralUids
            )
              ? current.paidDirectReferralUids
              : [];

          /*
            Same buyer must not be counted
            twice as a direct paid referral.
          */
          const alreadyCounted =
            paidList.includes(uid);

          let directCount =
            Number(
              current.directReferralCount ||
              0
            );

          let newLevel =
            oldLevel;

          /*
            Only Generation 1 increases
            direct referral count.
          */
          if (
            item.generation === 1 &&
            !alreadyCounted
          ) {

            directCount += 1;

            newLevel =
              Math.min(
                60,
                directCount
              );
          }

          /*
            Direct commission uses the
            new level after this paid referral.
          */
          const rate =
            item.generation === 1
              ? directRate(newLevel)
              : generationRates[
                  item.generation
                ];

          const commission =
            Math.round(
              amount *
                rate *
                100
            ) / 100;

          commissionTotal +=
            commission;

          const oldReferralEarnings =
            Number(
              current.referralEarnings ||
              0
            );

          const oldEarnings =
            Number(
              current.earnings ||
              0
            );

          const oldTotalEarnings =
            Number(
              current.totalEarnings ||
              0
            );

          /*
            Commission goes into the
            client's IDWP wallet ledger.
          */
          const update = {

            referralEarnings:
              oldReferralEarnings +
              commission,

            earnings:
              oldEarnings +
              commission,

            totalEarnings:
              oldTotalEarnings +
              commission,

            level:
              newLevel,

            referralCommissionRate:
              directRate(newLevel),

            updatedAt:
              admin.firestore.FieldValue
                .serverTimestamp()
          };

          /*
            Direct paid referral data.
          */
          if (
            item.generation === 1 &&
            !alreadyCounted
          ) {

            update.directReferralCount =
              directCount;

            update.freePackageEligible =
              directCount >= 8;

            update.paidDirectReferralUids =
              admin.firestore.FieldValue
                .arrayUnion(uid);
          }

          transaction.update(
            ref,
            update
          );

          /*
            Save individual commission record.
          */
          const commissionRef =
            db.collection(
              "referralCommissions"
            ).doc(
              `${orderId}_G${item.generation}_${ref.id}`
            );

          transaction.set(
            commissionRef,
            {

              orderId,

              buyerUid:
                uid,

              beneficiaryUid:
                ref.id,

              beneficiaryUserId:
                current.userID ||
                null,

              generation:
                item.generation,

              rate,

              amount:
                commission,

              packageName,

              purchaseAmount:
                amount,

              status:
                "CREDITED",

              createdAt:
                admin.firestore.FieldValue
                  .serverTimestamp()
            }
          );
        }

        /*
          --------------------------------
          8 DIRECT PAID REFERRALS
          = FREE PACKAGE ELIGIBILITY
          --------------------------------
        */

        const directPaidCount =
          Number(
            buyer.directReferralCount ||
            0
          );

        /*
          Buyer earns the free package
          when THEY have 8 direct paid
          referrals.

          The reward is only awarded once.
        */
        if (
          directPaidCount >= 8 &&
          buyer.freePackageEligible === true &&
          buyer.freePackageRewardClaimed !== true
        ) {

          transaction.update(
            userRef,
            {
              freePackageReward:
                true,

              freePackageRewardClaimed:
                false,

              freePackageRewardMessage:
                "You have earned 1 free package from IDWP for 8 direct paid referrals.",

              updatedAt:
                admin.firestore.FieldValue
                  .serverTimestamp()
            }
          );

          freePackageAwarded =
            true;
        }

        /*
          --------------------------------
          ORDER UPDATE
          --------------------------------

          Customer's full package payment
          is recorded against IDWP's
          Cashfree merchant collection.

          Referral commission is an
          internal wallet liability.
        */

        const totalCommission =
          Math.round(
            commissionTotal *
              100
          ) / 100;

        const idwpGross =
          Math.round(
            (amount -
              totalCommission) *
              100
          ) / 100;

        transaction.update(
          orderRef,
          {

            status:
              "paid",

            paidAt:
              admin.firestore.FieldValue
                .serverTimestamp(),

            referralProcessed:
              true,

            totalReferralCommission:
              totalCommission,

            idwpGrossBeforeGatewayFees:
              idwpGross,

            updatedAt:
              admin.firestore.FieldValue
                .serverTimestamp()
          }
        );
      }
    );

    /*
      Successful final response.
    */
    return send(
      res,
      200,
      {

        success: true,

        paid: true,

        status: "paid",

        orderId,

        packageName:
          order.packageName,

        amount:
          Number(order.amount || 0),

        referralCommission:
          Math.round(
            commissionTotal *
              100
          ) / 100,

        idwpGrossBeforeGatewayFees:
          Math.round(
            (
              Number(order.amount || 0) -
              commissionTotal
            ) * 100
          ) / 100,

        freePackageAwarded
      },
      origin
    );

  } catch (error) {

    console.error(
      "verify-payment error:",
      error
    );

    return send(
      res,
      500,
      {
        success: false,
        error:
          error.message ||
          "Payment verification failed"
      },
      origin
    );
  }
};
