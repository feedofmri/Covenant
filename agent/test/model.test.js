// The Claude adapter against a local fake of the Messages API: request shape, structured-output parsing,
// refusals, rate limits and malformed output all fail closed, and the planner falls back to the offline rules.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { buildLlmPlanSchema } from "@covenant/shared";
import { createModel, ModelUnavailable } from "../src/model/adapter.js";
import { propose } from "../src/planner.js";

let server, url, mode = "ok", lastBody = null, lastHeaders = null;
const plan = {
  intent: "Send 200 USDC to Mother", explanation: "Monthly support.", clarification: null,
  actions: [{ type: "pay", payee: "Mother", asset: "USDC", to_asset: null, amount: "200", bucket: "FAMILY", to_bucket: null, splits: null, purpose: "support", new_payee_label: null, new_payee_address: null, reason: null }],
};
const message = (text, stop_reason = "end_turn", extra = {}) => ({
  id: "msg_test", type: "message", role: "assistant", model: lastBody?.model, content: text == null ? [] : [{ type: "text", text }],
  stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 }, ...extra,
});

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastBody = JSON.parse(body || "{}");
      lastHeaders = req.headers;
      const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json", "request-id": "req_test" }); res.end(JSON.stringify(obj)); };
      if (mode === "ok") return send(200, message(JSON.stringify(plan)));
      if (mode === "refusal") return send(200, message(null, "refusal", { stop_details: { type: "refusal", category: "cyber", explanation: "x" } }));
      if (mode === "ratelimit") return send(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } });
      if (mode === "badjson") return send(200, message("{not json"));
      if (mode === "badschema") return send(200, message(JSON.stringify({ ...plan, actions: [{ ...plan.actions[0], payee: "Attacker" }] })));
      return send(500, { type: "error", error: { type: "api_error", message: "boom" } });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}`;
  process.env.ANTHROPIC_BASE_URL = url;
  process.env.ANTHROPIC_API_KEY = "sk-test";
});
after(() => server?.close());

const cfg = () => ({ provider: "anthropic", planner: "claude-opus-5-5", classifier: "claude-haiku-5-5", plannerEffort: "medium", timeoutMs: 5000, fixtureDir: "", record: false });
const schema = () => buildLlmPlanSchema(["Mother", "School"]);

test("sends a structured-output request to the planner model and parses the plan", async () => {
  mode = "ok";
  const m = createModel(cfg());
  const { output, model } = await m.complete({ task: "plan", system: "sys", user: "send 200 to Mother", schema: schema() });
  assert.equal(model, "claude-opus-5-5");
  assert.equal(output.actions[0].payee, "Mother");
  assert.equal(lastBody.model, "claude-opus-5-5");
  assert.equal(lastBody.output_config.effort, "medium");
  assert.equal(lastBody.output_config.format.type, "json_schema");
  // The SDK's zod helper sends the payee enum as a described string; the hard check is the zod validation of the
  // reply (see "schema violation" below), which rejects any unregistered payee.
  assert.match(JSON.stringify(lastBody.output_config.format.schema.properties.actions.items.properties.payee), /Mother.*School/);
  assert.equal(lastBody.system, "sys");
  assert.equal(lastHeaders["x-api-key"], "sk-test");
  assert.equal(lastBody.thinking, undefined, "no thinking override (Opus 5.5 rejects disabled thinking)");
});

test("the classifier uses the small model at low effort", async () => {
  mode = "ok";
  const { z } = await import("zod");
  const S = z.object({ injection: z.boolean(), score: z.number(), reason: z.string() });
  const orig = plan;
  mode = "classify";
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { lastBody = JSON.parse(b); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(message(JSON.stringify({ injection: true, score: 0.9, reason: "asks to move money" })))); });
  });
  const { output, model } = await createModel(cfg()).complete({ task: "classify", system: "s", user: "u", schema: S });
  assert.equal(model, "claude-haiku-5-5");
  assert.equal(lastBody.output_config.effort, "low");
  assert.equal(output.injection, true);
  assert.ok(orig);
});

for (const [name, m] of [["refusal", "refusal"], ["rate limit", "ratelimit"], ["malformed JSON", "badjson"], ["schema violation (unregistered payee)", "badschema"], ["server error", "error"]]) {
  test(`${name} fails closed with ModelUnavailable`, async () => {
    mode = m;
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        lastBody = JSON.parse(b || "{}");
        const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
        if (mode === "refusal") return send(200, message(null, "refusal", { stop_details: { type: "refusal", category: "cyber", explanation: "x" } }));
        if (mode === "ratelimit") return send(429, { type: "error", error: { type: "rate_limit_error", message: "slow" } });
        if (mode === "badjson") return send(200, message("{not json"));
        if (mode === "badschema") return send(200, message(JSON.stringify({ ...plan, actions: [{ ...plan.actions[0], payee: "Attacker" }] })));
        return send(500, { type: "error", error: { type: "api_error", message: "boom" } });
      });
    });
    const model = createModel({ ...cfg(), timeoutMs: 3000 });
    await assert.rejects(model.complete({ task: "plan", system: "s", user: "u", schema: schema() }), (e) => e instanceof ModelUnavailable || /model/.test(e.message));
  });
}

test("planner falls back to the offline rules when the model is unavailable", async () => {
  mode = "error";
  const state = {
    payees: [{ alias: "Mother", active: true, coolingOff: false }],
    assets: { USDC: { symbol: "USDC", decimals: 6, unallocated: 0n, balance: 0n, buckets: { FAMILY: 500000000n, EMERGENCY: 0n, SAVINGS: 0n }, policy: { perTxCap: 1n, dailyCap: 1n, t2Ceiling: 1n, lendingCap: 1n }, outflow24h: 0n, supplied: 0n, price: 1 } },
    mandate: null, paused: false,
  };
  const res = await propose({ model: createModel({ ...cfg(), timeoutMs: 2000 }), state, trigger: { type: "owner_chat", channel: "telegram-owner", text: "send 200 to Mother" }, provider: "anthropic" });
  assert.match(res.model, /^offline:rules-v1 \(fallback: /);
  assert.equal(res.plan.actions[0].type, "pay");
  assert.equal(res.plan.actions[0].amount, "200");
});
