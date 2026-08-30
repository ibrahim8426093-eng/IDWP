export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const body = req.body || {};
    const amount = body.amount;
    const packageName = body.packageName;

    if (!amount || !packageName) {
      return res.status(400).json({
        error: "Missing amount or packageName"
      });
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    console.log("RAZORPAY CHECK:", {
      keyIdExists: Boolean(keyId),
      keySecretExists: Boolean(keySecret),
      keyIdPrefix: keyId ? keyId.substring(0, 9) : null
    });

    if (!keyId || !keySecret) {
      return res.status(500).json({
        error: "Razorpay Production environment variables are missing",
        keyIdExists: Boolean(keyId),
        keySecretExists: Boolean(keySecret)
      });
    }

    const auth = Buffer
      .from(`${keyId}:${keySecret}`)
      .toString("base64");

    const razorpayResponse = await fetch(
      "https://api.razorpay.com/v1/orders",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: Math.round(Number(amount) * 100),
          currency: "INR",
          receipt: `idwp_${Date.now()}`,
          notes: {
            packageName: String(packageName)
          }
        })
      }
    );

    const data = await razorpayResponse.json();

    console.log("RAZORPAY RESPONSE:", {
      status: razorpayResponse.status,
      ok: razorpayResponse.ok,
      description: data?.error?.description || null
    });

    if (!razorpayResponse.ok) {
      return res.status(razorpayResponse.status).json({
        error:
          data?.error?.description ||
          "Razorpay order creation failed"
      });
    }

    return res.status(200).json({
      orderId: data.id,
      amount: data.amount,
      currency: data.currency,
      keyId: keyId
    });

  } catch (error) {
    console.error("CREATE ORDER ERROR:", error);

    return res.status(500).json({
      error: error?.message || "Server error"
    });
  }
}
