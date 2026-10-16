// Runtime configuration from the environment. Secrets are read here and never passed into model context.
import "./env.js";

const num = (v, d) => (v === undefined || v === "" ? d : Number(v));

export function loadConfig(overrides = {}) {
  const env = process.env;
  return {
    deployment: env.DEPLOYMENT || "localhost",
    rpcUrls: (env.RPC_URLS || env.BASE_SEPOLIA_RPC_URL || "http://127.0.0.1:8545").split(",").map((s) => s.trim()).filter(Boolean),
    simRpcUrl: env.SIM_RPC_URL || "", // a fork node (anvil or hardhat) used for pre-trade simulation
    simForkUrl: env.SIM_FORK_URL || "",
    simMode: env.SIM_MODE || "", // fork | snapshot | eth_call (default: fork if SIM_RPC_URL, snapshot on chain 31337) // when set, the sim node is reset to this chain's latest block before each run
    agentPrivateKey: env.AGENT_PRIVATE_KEY || "",
    model: {
      provider: env.MODEL_PROVIDER || (env.ANTHROPIC_API_KEY ? "anthropic" : "offline"),
      planner: env.PLANNER_MODEL || "claude-opus-5-5",
      classifier: env.CLASSIFIER_MODEL || "claude-haiku-5-5",
      plannerEffort: env.PLANNER_EFFORT || "medium",
      timeoutMs: num(env.MODEL_TIMEOUT_MS, 30000),
      fixtureDir: env.MODEL_FIXTURE_DIR || "",
      record: env.MODEL_RECORD === "1",
    },
    anchorMode: env.ANCHOR_MODE || "each", // each | batch
    simTolerance: 1n,
    ...overrides,
  };
}
