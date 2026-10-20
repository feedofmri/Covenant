// Model adapter. Provider-agnostic interface: complete({ task, system, user, schema }) → { output, model }.
// Providers: "anthropic" (Claude via the official SDK, structured outputs), "offline" (deterministic rules,
// used in CI and when no key is configured), "hijacked" (red-team: obeys injected instructions on purpose).
// Fixture replay makes tests deterministic without network access.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema.mjs";
import * as z from "zod/v4";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { keccak256, toHex } from "viem";
import { offlineComplete } from "./offline.js";
import { hijackedComplete } from "./hijacked.js";

export class ModelUnavailable extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "ModelUnavailable";
    this.cause = cause;
  }
}

export function createModel(modelConfig) {
  let client = null;
  const getClient = () => (client ??= new Anthropic({ timeout: modelConfig.timeoutMs, maxRetries: 2 }));

  async function viaOpenAI({ task, system, user, schema }) {
    const apiKey = modelConfig.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new ModelUnavailable("OPENAI_API_KEY is not configured");
    const model = task === "classify" ? modelConfig.classifier : modelConfig.planner;
    const jsonSchema = transformJSONSchema(z.toJSONSchema(schema, { reused: "ref" }));

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), modelConfig.timeoutMs || 30000);
      let res;
      try {
        res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: `${system}\n\nIMPORTANT: Use null for fields that do not apply.` },
              { role: "user", content: user },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: task,
                strict: true,
                schema: jsonSchema,
              },
            },
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const msg = errBody?.error?.message ?? `HTTP ${res.status}`;
        if (res.status === 429) throw new ModelUnavailable("model rate limited", new Error(msg));
        throw new ModelUnavailable(`OpenAI API error ${res.status}: ${msg}`);
      }

      const data = await res.json();
      const choice = data.choices?.[0];
      if (choice?.finish_reason === "content_filter") throw new ModelUnavailable("model declined (content filter)");
      if (choice?.finish_reason === "length") throw new ModelUnavailable("model output truncated");
      const content = choice?.message?.content;
      if (!content) throw new ModelUnavailable("model returned empty response");

      let parsedJson;
      try {
        parsedJson = JSON.parse(content);
      } catch (err) {
        throw new ModelUnavailable(`failed to parse model output as JSON: ${err.message}`);
      }

      const validated = schema.safeParse(parsedJson);
      if (!validated.success) {
        const issues = validated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
        throw new ModelUnavailable(`model output failed schema validation: ${issues}`);
      }

      return { output: validated.data, model };
    } catch (e) {
      if (e instanceof ModelUnavailable) throw e;
      if (e.name === "AbortError") throw new ModelUnavailable("model request timed out", e);
      throw new ModelUnavailable(`model call failed: ${e.message}`, e);
    }
  }

  async function viaAnthropic({ task, system, user, schema }) {
    const model = task === "classify" ? modelConfig.classifier : modelConfig.planner;
    const effort = task === "classify" ? "low" : modelConfig.plannerEffort;
    try {
      const res = await getClient().messages.parse({
        model,
        max_tokens: task === "classify" ? 1024 : 8000,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { format: zodOutputFormat(schema), effort },
      });
      // A refusal is treated as "no plan": the agent fails closed and does nothing.
      if (res.stop_reason === "refusal") throw new ModelUnavailable(`model declined (${res.stop_details?.category ?? "refusal"})`);
      if (res.stop_reason === "max_tokens") throw new ModelUnavailable("model output truncated");
      if (!res.parsed_output) throw new ModelUnavailable("model output failed schema validation");
      return { output: res.parsed_output, model };
    } catch (e) {
      if (e instanceof ModelUnavailable) throw e;
      if (e instanceof Anthropic.RateLimitError) throw new ModelUnavailable("model rate limited", e);
      if (e instanceof Anthropic.APIConnectionError) throw new ModelUnavailable("model unreachable", e);
      if (e instanceof Anthropic.APIError) throw new ModelUnavailable(`model API error ${e.status}`, e);
      throw new ModelUnavailable(`model call failed: ${e.message}`, e);
    }
  }

  const fixtureKey = (req) => keccak256(toHex(JSON.stringify([req.task, req.system, req.user]))).slice(2, 18);

  async function complete(req) {
    const provider = req.provider ?? modelConfig.provider;
    const dir = modelConfig.fixtureDir;
    if (dir && provider !== "hijacked") {
      const file = path.join(dir, `${req.task}-${fixtureKey(req)}.json`);
      if (existsSync(file) && !modelConfig.record) {
        const f = JSON.parse(readFileSync(file, "utf8"));
        return { output: req.schema.parse(f.output), model: `fixture:${f.model}` };
      }
      const res = await completeLive(provider, req);
      if (modelConfig.record) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, JSON.stringify({ task: req.task, user: req.user, model: res.model, output: res.output }, null, 2));
      }
      return res;
    }
    return completeLive(provider, req);
  }

  async function completeLive(provider, req) {
    if (provider === "openai") return viaOpenAI(req);
    if (provider === "anthropic") return viaAnthropic(req);
    if (provider === "hijacked") return { output: req.schema.parse(hijackedComplete(req)), model: "redteam:hijacked-planner" };
    return { output: req.schema.parse(offlineComplete(req)), model: "offline:rules-v1" };
  }

  return { complete, provider: modelConfig.provider };
}
