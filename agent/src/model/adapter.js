// Model adapter. Provider-agnostic interface: complete({ task, system, user, schema }) → { output, model }.
// Providers: "anthropic" (Claude via the official SDK), "openai" / "chatgpt" (ChatGPT/GPT-4o via OpenAI Chat Completions),
// "offline" (deterministic rules, used in CI and when no key is configured), "hijacked" (red-team: obeys injected instructions on purpose).
// Fixture replay makes tests deterministic without network access.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
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

  async function viaOpenAI({ task, system, user, schema }) {
    const model = task === "classify" ? modelConfig.classifier : modelConfig.planner;
    const apiKey = modelConfig.openaiApiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new ModelUnavailable("OPENAI_API_KEY is not configured");

    const baseUrl = (modelConfig.openaiBaseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
    const jsonSchema = z.toJSONSchema(schema, { reused: "ref" });
    delete jsonSchema.$schema;

    const isReasoning = /^o[134]/i.test(model);
    const body = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: (task || "response").replace(/[^a-zA-Z0-9_-]/g, "_"),
          strict: true,
          schema: jsonSchema,
        },
      },
    };
    if (!isReasoning) {
      body.temperature = 0;
    }

    let res;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), modelConfig.timeoutMs || 30000);
      try {
        res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      if (e.name === "AbortError") throw new ModelUnavailable("model call timed out", e);
      throw new ModelUnavailable(`model unreachable: ${e.message}`, e);
    }

    if (!res.ok) {
      if (res.status === 429) throw new ModelUnavailable("model rate limited");
      const errText = await res.text().catch(() => "");
      throw new ModelUnavailable(`model API error ${res.status}: ${errText}`);
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new ModelUnavailable("failed to parse model API response as JSON", e);
    }

    const choice = data?.choices?.[0];
    if (choice?.message?.refusal) {
      throw new ModelUnavailable(`model declined (${choice.message.refusal})`);
    }
    if (choice?.finish_reason === "length") {
      throw new ModelUnavailable("model output truncated");
    }

    const rawContent = choice?.message?.content;
    if (!rawContent) {
      throw new ModelUnavailable("model output empty");
    }

    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch (e) {
      throw new ModelUnavailable("model output is not valid JSON", e);
    }

    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      throw new ModelUnavailable("model output failed schema validation");
    }

    return { output: validated.data, model };
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
    if (provider === "anthropic") return viaAnthropic(req);
    if (provider === "openai" || provider === "chatgpt") return viaOpenAI(req);
    if (provider === "hijacked") return { output: req.schema.parse(hijackedComplete(req)), model: "redteam:hijacked-planner" };
    return { output: req.schema.parse(offlineComplete(req)), model: "offline:rules-v1" };
  }

  return { complete, provider: modelConfig.provider };
}
