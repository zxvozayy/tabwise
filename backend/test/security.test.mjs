// Run: node --test test/
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { _test } from "../src/index.js";

const env = {
  SUPABASE_URL: "https://db.test",
  SUPABASE_SERVICE_KEY: "service",
  OPENAI_API_KEY: "openai",
  GROQ_API_KEY: "groq",
  LEMONSQUEEZY_WEBHOOK_SECRET: "whsec",
  RESEND_API_KEY: "resend",
  EMAIL_FROM: "Tabwise <login@test>",
};

// Minimal in-memory stand-in for the Supabase REST calls the Worker makes.
let db;
let calls;
beforeEach(() => {
  db = { subscriptions: [], sessions: [], login_codes: [], usage: {}, emails: [] };
  calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method || "GET";
    calls.push(`${method} ${url.host}${url.pathname}`);
    const body = init.body ? JSON.parse(init.body) : null;
    const eq = (k) => url.searchParams.get(k)?.replace(/^eq\./, "");
    const ok = (data) => new Response(data === undefined ? "" : JSON.stringify(data), { status: 200 });

    if (url.host === "api.resend.com") {
      db.emails.push(body);
      return ok({ id: "e1" });
    }
    if (url.host === "api.openai.com" || url.host === "api.groq.com") {
      return ok({ choices: [{ message: { content: `answer from ${url.host}` } }] });
    }
    const table = url.pathname.replace("/rest/v1/", "");
    if (table === "rpc/increment_usage") {
      const k = `${body.p_key}|${body.p_day}`;
      db.usage[k] = (db.usage[k] || 0) + 1;
      return ok(db.usage[k]);
    }
    if (table === "subscriptions") {
      if (method === "POST") {
        db.subscriptions = db.subscriptions.filter((s) => s.email !== body.email).concat(body);
        return ok();
      }
      return ok(db.subscriptions.filter((s) => s.email === eq("email")));
    }
    if (table === "sessions") {
      if (method === "POST") { db.sessions.push(body); return ok(); }
      if (method === "DELETE") { db.sessions = db.sessions.filter((s) => s.token_hash !== eq("token_hash")); return ok(); }
      return ok(db.sessions.filter((s) => s.token_hash === eq("token_hash")));
    }
    if (table === "login_codes") {
      if (method === "POST") { db.login_codes.push({ id: db.login_codes.length + 1, attempts: 0, used_at: null, ...body }); return ok(); }
      if (method === "PATCH") { Object.assign(db.login_codes.find((c) => c.id === Number(eq("id"))), body); return ok(); }
      const rows = db.login_codes.filter((c) => c.email === eq("email") && (!url.searchParams.has("used_at") || c.used_at === null));
      return ok(rows.reverse());
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});

const call = (method, path, { body, headers = {} } = {}) =>
  worker.fetch(
    new Request(`https://api.test${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    env
  );

async function signIn(email) {
  await call("POST", "/auth/request-code", { body: { email } });
  const code = db.emails.at(-1).text.match(/\d{6}/)[0];
  const res = await call("POST", "/auth/verify", { body: { email, code } });
  return (await res.json()).token;
}

function webhookPayload(email, status) {
  return JSON.stringify({
    meta: { event_name: "subscription_updated" },
    data: { id: 42, attributes: { user_email: email, status, ends_at: null } },
  });
}

test("webhook rejects unsigned and wrongly signed requests", async () => {
  const raw = webhookPayload("victim@example.com", "active");
  assert.equal((await call("POST", "/webhook", { body: raw })).status, 401);
  assert.equal((await call("POST", "/webhook", { body: raw, headers: { "X-Signature": "00".repeat(32) } })).status, 401);
  assert.equal(db.subscriptions.length, 0);
});

test("webhook accepts a valid Lemon Squeezy signature", async () => {
  const raw = webhookPayload("Buyer@Example.com", "active");
  const sig = await _test.hmacSha256Hex(env.LEMONSQUEEZY_WEBHOOK_SECRET, raw);
  const res = await call("POST", "/webhook", { body: raw, headers: { "X-Signature": sig } });
  assert.equal(res.status, 200);
  assert.deepEqual(
    { email: db.subscriptions[0].email, plan: db.subscriptions[0].plan },
    { email: "buyer@example.com", plan: "PRO" }
  );
});

test("webhook refuses to run without a configured secret", async () => {
  const raw = webhookPayload("x@example.com", "active");
  const sig = await _test.hmacSha256Hex("", raw).catch(() => "");
  const res = await worker.fetch(
    new Request("https://api.test/webhook", { method: "POST", body: raw, headers: { "X-Signature": sig } }),
    { ...env, LEMONSQUEEZY_WEBHOOK_SECRET: "" }
  );
  assert.equal(res.status, 500);
  assert.equal(db.subscriptions.length, 0);
});

test("check-subscription no longer answers for an arbitrary email", async () => {
  db.subscriptions.push({ email: "pro@example.com", plan: "PRO", status: "active" });
  const res = await call("GET", "/check-subscription?email=pro@example.com");
  assert.equal(res.status, 401);
});

test("/ask requires a session and does not trust a supplied email", async () => {
  db.subscriptions.push({ email: "pro@example.com", plan: "PRO", status: "active" });
  const res = await call("POST", "/ask", { body: { prompt: "hi", email: "pro@example.com" } });
  assert.equal(res.status, 401);
  assert.ok(!calls.some((c) => c.includes("api.openai.com")));
});

test("signed-in Pro user gets answers; subscription response has no internals", async () => {
  db.subscriptions.push({ email: "pro@example.com", plan: "PRO", status: "active", lemonsqueezy_subscription_id: "42" });
  const token = await signIn("pro@example.com");

  const sub = await (await call("GET", "/check-subscription", { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(sub, { email: "pro@example.com", plan: "PRO", status: "active" });

  const ask = await call("POST", "/ask", { body: { prompt: "hi" }, headers: { Authorization: `Bearer ${token}` } });
  assert.equal(ask.status, 200);
  assert.equal((await ask.json()).answer, "answer from api.openai.com");
});

test("signed-in Free user is refused on /ask", async () => {
  const token = await signIn("free@example.com");
  const res = await call("POST", "/ask", { body: { prompt: "hi" }, headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 403);
});

test("wrong code is rejected and attempts are capped", async () => {
  await call("POST", "/auth/request-code", { body: { email: "a@example.com" } });
  const real = db.emails.at(-1).text.match(/\d{6}/)[0];
  const wrong = real === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) {
    assert.equal((await call("POST", "/auth/verify", { body: { email: "a@example.com", code: wrong } })).status, 400);
  }
  // Even the right code fails once the attempt budget is spent.
  assert.equal((await call("POST", "/auth/verify", { body: { email: "a@example.com", code: real } })).status, 400);
  assert.equal(db.sessions.length, 0);
});

test("stored codes and tokens are hashed", async () => {
  const token = await signIn("h@example.com");
  const code = db.emails.at(-1).text.match(/\d{6}/)[0];
  assert.ok(!db.login_codes.some((c) => c.code_hash.includes(code)));
  assert.ok(!db.sessions.some((s) => s.token_hash === token));
});

test("free tier goes through the backend and is capped per install", async () => {
  const clientId = "123e4567-e89b-12d3-a456-426614174000";
  for (let i = 0; i < 10; i++) {
    const res = await call("POST", "/ask-free", { body: { prompt: "hi", clientId } });
    assert.equal(res.status, 200);
  }
  assert.equal((await call("POST", "/ask-free", { body: { prompt: "hi", clientId } })).status, 429);
});

test("free tier is capped per IP even if the install id rotates", async () => {
  let last;
  for (let i = 0; i < 31; i++) {
    const clientId = `123e4567-e89b-12d3-a456-${String(i).padStart(12, "0")}`;
    last = await call("POST", "/ask-free", { body: { prompt: "hi", clientId }, headers: { "CF-Connecting-IP": "1.2.3.4" } });
  }
  assert.equal(last.status, 429);
});

test("cancelled subscription stays Pro until ends_at", async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  db.subscriptions.push({ email: "c@example.com", plan: "FREE", status: "cancelled", ends_at: future });
  const token = await signIn("c@example.com");
  const sub = await (await call("GET", "/check-subscription", { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(sub.plan, "PRO");
});
