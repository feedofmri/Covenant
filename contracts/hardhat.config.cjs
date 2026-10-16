// Hardhat config (CommonJS: Hardhat 2 loads configs with require()).
require("@nomicfoundation/hardhat-viem");
require("@nomicfoundation/hardhat-network-helpers");
require("@nomicfoundation/hardhat-verify");
require("solidity-coverage");
const path = require("node:path");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const SOLC_VERSION = "0.8.28";

// Use the solc-js build shipped in node_modules/solc instead of downloading a compiler.
// Keeps builds reproducible in CI and in networks that block binaries.soliditylang.org.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion !== SOLC_VERSION || process.env.USE_NATIVE_SOLC === "1") return runSuper();
  const solc = require("solc");
  return {
    compilerPath: require.resolve("solc/soljson.js"),
    isSolcJs: true,
    version: args.solcVersion,
    longVersion: solc.version(),
  };
});

const accounts = [process.env.DEPLOYER_PRIVATE_KEY].filter(Boolean);

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    version: SOLC_VERSION,
    settings: { optimizer: { enabled: true, runs: 1 }, evmVersion: "cancun", viaIR: true },
  },
  paths: { sources: "./src", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
  networks: {
    // Under `hardhat node`, reverted txs are still mined and return a hash (as on a real chain), so red-team
    // evidence works locally. In-process tests keep throwing so expectRevert() sees the error.
    hardhat: { chainId: 31337, allowUnlimitedContractSize: process.env.COVERAGE === "1", throwOnTransactionFailures: !process.argv.includes("node") },
    localhost: { url: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545", chainId: 31337 },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts,
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
    customChains: [
      {
        network: "baseSepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=84532",
          browserURL: "https://sepolia.basescan.org",
        },
      },
    ],
  },
  sourcify: { enabled: true },
  mocha: { timeout: 120000 },
};
