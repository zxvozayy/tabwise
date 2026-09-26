// Tabwise backend (Cloudflare Worker)
//
// Required secrets (wrangler secret put <NAME>):
//   SUPABASE_SERVICE_KEY          Supabase service_role key
//   OPENAI_API_KEY                used for PRO requests (/ask)
//   GROQ_API_KEY                  used for FREE requests (/ask-free)
//   LEMONSQUEEZY_WEBHOOK_SECRET   signing secret of the Lemon Squeezy webhook
//   RESEND_API_KEY                sends the sign-in codes
// Vars (wrangler.jsonc):
//   SUPABASE_URL, EMAIL_FROM
//
// Identity: the extension proves it owns an email with a 6-digit code sent to
// that address, and receives an opaque session token. Only the SHA-256 of codes
// and tokens is stored.

const FREE_DAILY_LIMIT = 10;        // per install
const FREE_DAILY_LIMIT_PER_IP = 30; // stops install-id rotation
const PRO_DAILY_LIMIT = 50;
const MAX_PROMPT_CHARS = 20000;
const MAX_OUTPUT_TOKENS = 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODES_PER_HOUR = 5;
const MAX_CODE_ATTEMPTS = 5;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const ENTITLED_STATUSES = new Set(["active", "on_trial"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    try {
      switch (route) {
        case "POST /webhook":
          return await handleWebhook(request, env);
        case "POST /auth/request-code":
          return await handleRequestCode(request, env);
        case "POST /auth/verify":
          return await handleVerify(request, env);
        case "POST /auth/logout":
          return await handleLogout(request, env);
        case "GET /check-subscription":
          return await handleCheckSubscription(request, env);
        case "POST /ask":
          return await handleAsk(request, env);
        case "POST /ask-free":
          return await handleAskFree(request, env);
        default:
          return json({ error: "Not found" }, 404);
      }
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Internal error" }, 500);
    }
  },
};

// =============================
// LEMON SQUEEZY WEBHOOK
// =============================
async function handleWebhook(request, env) {
  if (!env.LEMONSQUEEZY_WEBHOOK_SECRET) {
    console.error("LEMONSQUEEZY_WEBHOOK_SECRET is not set");
    return json({ error: "Webhook not configured" }, 500);
  }

  const raw = await request.text();
  const signature = request.headers.get("X-Signature") || "";
  const expected = await hmacSha256Hex(env.LEMONSQUEEZY_WEBHOOK_SECRET, raw);

  if (!timingSafeEqual(signature, expected)) {
    return json({ error: "Invalid signature" }, 401);
  }

  const body = JSON.parse(raw);
  const eventName = body?.meta?.event_name || "";
  if (!eventName.startsWith("subscription_")) {
    return json({ ok: true, ignored: eventName });
  }

  const attrs = body?.data?.attributes || {};
  const email = normalizeEmail(attrs.user_email);
  if (!email) throw new HttpError(400, "Missing email");

  await supabase(env, "subscriptions?on_conflict=email", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      email,
      plan: ENTITLED_STATUSES.has(attrs.status) ? "PRO" : "FREE",
      status: attrs.status,
      ends_at: attrs.ends_at || null,
      lemonsqueezy_subscription_id: String(body.data.id),
      updated_at: new Date().toISOString(),
    }),
  });

  return json({ ok: true });
}

// =============================
// EMAIL SIGN-IN
// =============================
async function handleRequestCode(request, env) {
  const { email: rawEmail } = await readJson(request);
  const email = normalizeEmail(rawEmail);
  if (!email) throw new HttpError(400, "Valid email required");

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await supabase(
    env,
    `login_codes?select=id&email=eq.${enc(email)}&created_at=gte.${enc(hourAgo)}`
  );
  if (recent.length >= MAX_CODES_PER_HOUR) {
    throw new HttpError(429, "Too many codes requested. Try again later.");
  }

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");

  await supabase(env, "login_codes", {
    method: "POST",
    body: JSON.stringify({
      email,
      code_hash: await sha256Hex(`${email}:${code}`),
      expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    }),
  });

  const sent = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: email,
      subject: `Your Tabwise sign-in code: ${code}`,
      text: `Your Tabwise sign-in code is ${code}\n\nIt expires in 10 minutes. If you didn't request it, you can ignore this email.`,
    }),
  });
  if (!sent.ok) {
    console.error("Resend error", sent.status, await sent.text());
    throw new HttpError(502, "Could not send the code. Try again.");
  }

  return json({ ok: true });
}

async function handleVerify(request, env) {
  const { email: rawEmail, code } = await readJson(request);
  const email = normalizeEmail(rawEmail);
  if (!email || !/^\d{6}$/.test(String(code || ""))) {
    throw new HttpError(400, "Email and 6-digit code required");
  }

  const [row] = await supabase(
    env,
    `login_codes?select=id,code_hash,attempts,expires_at&email=eq.${enc(email)}&used_at=is.null&order=created_at.desc&limit=1`
  );
  if (!row || new Date(row.expires_at) < new Date() || row.attempts >= MAX_CODE_ATTEMPTS) {
    throw new HttpError(400, "Code expired. Request a new one.");
  }

  const matches = timingSafeEqual(row.code_hash, await sha256Hex(`${email}:${code}`));
  await supabase(env, `login_codes?id=eq.${row.id}`, {
    method: "PATCH",
    body: JSON.stringify(
      matches ? { used_at: new Date().toISOString() } : { attempts: row.attempts + 1 }
    ),
  });
  if (!matches) throw new HttpError(400, "Wrong code");

  const token = randomToken();
  await supabase(env, "sessions", {
    method: "POST",
    body: JSON.stringify({
      token_hash: await sha256Hex(token),
      email,
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    }),
  });

  return json({ token, email, ...(await getEntitlement(env, email)) });
}

async function handleLogout(request, env) {
  const token = bearerToken(request);
  if (token) {
    await supabase(env, `sessions?token_hash=eq.${await sha256Hex(token)}`, { method: "DELETE" });
  }
  return json({ ok: true });
}

// =============================
// SUBSCRIPTION STATUS
// =============================
async function handleCheckSubscription(request, env) {
  const email = await requireSession(request, env);
  return json({ email, ...(await getEntitlement(env, email)) });
}

// =============================
// PRO: OPENAI VIA BACKEND
// =============================
async function handleAsk(request, env) {
  const email = await requireSession(request, env);
  const { plan } = await getEntitlement(env, email);
  if (plan !== "PRO") throw new HttpError(403, "Pro subscription required");

  const { prompt } = await readJson(request);
  requirePrompt(prompt);

  const used = await incrementUsage(env, `pro:${email}`);
  if (used > PRO_DAILY_LIMIT) throw new HttpError(429, "Daily Pro limit reached");

  const answer = await chatCompletion({
    url: "https://api.openai.com/v1/chat/completions",
    apiKey: env.OPENAI_API_KEY,
    model: "gpt-4o-mini",
    prompt,
  });
  return json({ answer, used, limit: PRO_DAILY_LIMIT });
}

// =============================
// FREE: GROQ VIA BACKEND
// =============================
async function handleAskFree(request, env) {
  const { prompt, clientId } = await readJson(request);
  requirePrompt(prompt);
  if (!/^[0-9a-f-]{36}$/i.test(String(clientId || ""))) {
    throw new HttpError(400, "Missing client id");
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipKey = `free-ip:${await sha256Hex(ip)}`;

  const usedByIp = await incrementUsage(env, ipKey);
  if (usedByIp > FREE_DAILY_LIMIT_PER_IP) throw new HttpError(429, "Daily free limit reached");

  const used = await incrementUsage(env, `free:${clientId.toLowerCase()}`);
  if (used > FREE_DAILY_LIMIT) throw new HttpError(429, "Daily free limit reached");

  const answer = await chatCompletion({
    url: "https://api.groq.com/openai/v1/chat/completions",
    apiKey: env.GROQ_API_KEY,
    model: "llama-3.3-70b-versatile",
    prompt,
  });
  return json({ answer, used, limit: FREE_DAILY_LIMIT });
}

// =============================
// HELPERS
// =============================
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function requirePrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new HttpError(400, "Missing prompt");
  if (prompt.length > MAX_PROMPT_CHARS + 200) throw new HttpError(413, "Prompt too long");
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

const enc = encodeURIComponent;

function bearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

async function requireSession(request, env) {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "Sign in required");

  const [session] = await supabase(
    env,
    `sessions?select=email,expires_at&token_hash=eq.${await sha256Hex(token)}&limit=1`
  );
  if (!session || new Date(session.expires_at) < new Date()) {
    throw new HttpError(401, "Session expired. Sign in again.");
  }
  return session.email;
}

async function getEntitlement(env, email) {
  const [sub] = await supabase(
    env,
    `subscriptions?select=status,ends_at&email=eq.${enc(email)}&limit=1`
  );
  if (!sub) return { plan: "FREE", status: "inactive" };

  // A cancelled subscription stays usable until the paid period ends.
  const inGracePeriod =
    sub.status === "cancelled" && sub.ends_at && new Date(sub.ends_at) > new Date();
  const plan = ENTITLED_STATUSES.has(sub.status) || inGracePeriod ? "PRO" : "FREE";
  return { plan, status: sub.status };
}

async function incrementUsage(env, key) {
  const day = new Date().toISOString().slice(0, 10);
  return await supabase(env, "rpc/increment_usage", {
    method: "POST",
    body: JSON.stringify({ p_key: key, p_day: day }),
  });
}

async function chatCompletion({ url, apiKey, model, prompt }) {
  const finalPrompt =
    prompt.length > MAX_PROMPT_CHARS
      ? prompt.slice(0, MAX_PROMPT_CHARS) + "\n\n[Content truncated to fit API limits]"
      : prompt;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: finalPrompt }],
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.7,
    }),
  });
  if (!res.ok) {
    console.error("LLM error", res.status, await res.text());
    throw new HttpError(502, "AI provider error. Try again.");
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

async function supabase(env, path, init = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    console.error("Supabase error", path.split("?")[0], res.status, await res.text());
    throw new HttpError(500, "Database error");
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(digest);
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const _test = { hmacSha256Hex, timingSafeEqual, normalizeEmail, sha256Hex };
