export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =============================
    // CHECK SUBSCRIPTION
    // =============================
    if (url.pathname === "/check-subscription") {
      const email = url.searchParams.get("email");

      if (!email) {
        return new Response("Missing email", { status: 400 });
      }

      const response = await fetch(
        `${env.SUPABASE_URL}/rest/v1/subscriptions?select=*&email=eq.${email}`,
        {
          headers: {
            "apikey": env.SUPABASE_SERVICE_KEY,
            "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );

      const data = await response.json();

      if (!data.length) {
        return new Response(
          JSON.stringify({ plan: "FREE", status: "inactive" }),
          { headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify(data[0]), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // =============================
    // 🔒 SECURE ASK ENDPOINT (PRO ONLY)
    // =============================
    if (url.pathname === "/ask" && request.method === "POST") {
      const body = await request.json();
      const { prompt, email } = body;

      if (!email || !prompt) {
        return new Response("Missing email or prompt", { status: 400 });
      }

      // 🔎 Verify subscription
      const subRes = await fetch(
        `${env.SUPABASE_URL}/rest/v1/subscriptions?select=*&email=eq.${email}`,
        {
          headers: {
            "apikey": env.SUPABASE_SERVICE_KEY,
            "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );

      const subs = await subRes.json();

      if (
        !subs.length ||
        subs[0].plan !== "PRO" ||
        subs[0].status !== "active"
      ) {
        return new Response("Not authorized", { status: 403 });
      }

      // ✅ Authorized → call OpenAI
      const openaiRes = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 1000,
            temperature: 0.7
          })
        }
      );

      if (!openaiRes.ok) {
        const errorText = await openaiRes.text();
        return new Response(errorText, { status: 500 });
      }

      const data = await openaiRes.json();

      return new Response(
        JSON.stringify({
          answer: data.choices[0].message.content
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // =============================
    // LEMON SQUEEZY WEBHOOK
    // =============================
    if (url.pathname.startsWith("/webhook") && request.method === "POST") {
      const body = await request.json();

      const email = body?.data?.attributes?.user_email;
      const status = body?.data?.attributes?.status;
      const subscriptionId = body?.data?.id;

      if (!email) {
        return new Response("Missing email", { status: 400 });
      }

      const plan = status === "active" ? "PRO" : "FREE";

      await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions`, {
        method: "POST",
        headers: {
          "apikey": env.SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates"
        },
        body: JSON.stringify({
          email: email,
          plan: plan,
          status: status,
          lemonsqueezy_subscription_id: subscriptionId,
          updated_at: new Date().toISOString()
        })
      });

      return new Response("Webhook processed");
    }

    return new Response("Backend running");
  }
};
