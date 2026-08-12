// worker/paystack-verify.js
// Deploy with: wrangler deploy
// Bindings needed (set as Worker secrets, never hardcoded):
//   PAYSTACK_SEC_KEY   — Paystack secret key
//   SUPABASE_URL       — e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY — Supabase service_role key (server-only, NEVER shipped to the browser)
//   BREVO_API_KEY      — Brevo transactional email API key
//
// This Worker sits behind api.invites.devtem.org (or a workers.dev URL) and is
// the ONLY place that ever touches the service_role key. The dashboard only
// ever holds the public anon key.

const ALLOWED_ORIGINS = [
  "https://invites.devtem.org",
  "https://thedevetemedevsgitorgsite.github.io",
  "http://localhost:7700",
];

const TIER_DAYS = { pro: 30, premium: 30 };
const TIER_LABEL = { pro: "Pro", premium: "Premium" };

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
    }
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response(JSON.stringify({ error: "Unauthorized origin" }), { status: 403, headers });
    }

    // ---- 1. Identify the caller from their Supabase access token ----
    const authHeader = request.headers.get("authorization") || "";
    const accessToken = authHeader.replace("Bearer ", "");
    if (!accessToken) {
      return new Response(JSON.stringify({ error: "Missing session token" }), { status: 401, headers });
    }

    const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${accessToken}` },
    });
    if (!userRes.ok) {
      return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers });
    }
    const user = await userRes.json();

    try {
      const { reference, tier } = await request.json();
      if (!reference || !tier || !TIER_DAYS[tier]) {
        return new Response(JSON.stringify({ error: "Missing reference or invalid tier" }), { status: 400, headers });
      }

      // ---- 2. Verify the payment with Paystack (server-side, never trust the client) ----
      const paystackRes = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
        headers: { Authorization: `Bearer ${env.PAYSTACK_SEC_KEY}` },
      });
      const result = await paystackRes.json();

      if (!result.status || result.data?.status !== "success") {
        return new Response(JSON.stringify({ error: "Payment verification failed" }), { status: 400, headers });
      }

      // Confirm the amount actually matches the tier price (prevents a tampered client
      // from paying ₦100 and requesting "premium")
      const paidKobo = result.data.amount;
      const expectedNgn = { pro: 3500, premium: 9000 }[tier];
      if (paidKobo < expectedNgn * 100) {
        return new Response(JSON.stringify({ error: "Amount does not match selected plan" }), { status: 400, headers });
      }

      // ---- 3. Update the user's subscription in Supabase (service role, server-only) ----
      const expiresAt = new Date(Date.now() + TIER_DAYS[tier] * 86400000).toISOString();

      const updateRes = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
        method: "PATCH",
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ subscription_tier: tier, subscription_expires_at: expiresAt }),
      });

      if (!updateRes.ok) {
        return new Response(JSON.stringify({ error: "Payment verified but account update failed — contact support." }), {
          status: 500,
          headers,
        });
      }

      // ---- 4. Thank-you email via Brevo's HTTP API (Workers can't do raw SMTP) ----
      const paidNaira = (paidKobo / 100).toLocaleString();
      await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: { name: "D Invites", email: "support.d-invite@devtem.org" },
          to: [{ email: user.email }],
          subject: `You're on ${TIER_LABEL[tier]} — welcome!`,
          htmlContent: `
            <div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:24px">
              <h2 style="margin:0 0 12px">You're upgraded to ${TIER_LABEL[tier]}</h2>
              <p style="color:#555;line-height:1.6">Payment of ₦${paidNaira} confirmed. Your plan is active until ${new Date(expiresAt).toDateString()}.</p>
              <p style="color:#555;line-height:1.6">Reference: <strong>${reference}</strong></p>
              <a href="https://invites.devtem.org/dashboard.html" style="display:inline-block;margin-top:16px;padding:12px 22px;background:#00E6A0;color:#06120E;text-decoration:none;border-radius:24px;font-weight:700">Go to dashboard</a>
              <p style="font-size:12px;color:#999;margin-top:32px">D Invites · support.d-invite@devtem.org</p>
            </div>`,
        }),
      }).catch(() => {}); // don't fail the response if only the email leg breaks

      return new Response(
        JSON.stringify({ success: true, tier, expires_at: expiresAt }),
        { status: 200, headers }
      );
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message || "Internal error" }), { status: 500, headers });
    }
  },
};
