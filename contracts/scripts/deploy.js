// Deploys the full Covenant stack and creates the demo vault through the factory (owner-signed).
//   npx hardhat run scripts/deploy.js --network localhost
//   npx hardhat run scripts/deploy.js --network baseSepolia   (needs DEPLOYER_PRIVATE_KEY, OWNER_PRIVATE_KEY, …)
import hre from "hardhat";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletClient, http, parseUnits, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Mandate, hashCanonical, BUCKETS, payeeId, labelId } from "@covenant/shared";

const here = path.dirname(fileURLToPath(import.meta.url));
const shared = path.join(here, "..", "..", "shared");
const units = (n) => parseUnits(String(n), 6);
const env = (k, d) => process.env[k] || d;

async function main() {
  const network = hre.network.name;
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const local = chainId === 31337;
  const wallets = await hre.viem.getWalletClients();
  const deployer = wallets[0];

  // Role accounts: Hardhat's default accounts locally, environment on public networks.
  let owner, addr;
  if (local) {
    owner = wallets[1];
    addr = {
      owner: wallets[1].account.address, guardian: wallets[2].account.address, agent: wallets[3].account.address,
      mother: wallets[4].account.address, school: wallets[5].account.address, attacker: wallets[6].account.address,
      employer: wallets[7].account.address,
    };
  } else {
    const ownerKey = env("OWNER_PRIVATE_KEY");
    owner = ownerKey
      ? createWalletClient({ account: privateKeyToAccount(ownerKey), chain: publicClient.chain, transport: http(hre.network.config.url) })
      : deployer;
    const need = (k) => {
      const v = env(k);
      if (!v) throw new Error(`Set ${k} in .env`);
      return getAddress(v);
    };
    addr = {
      owner: owner.account.address, guardian: need("GUARDIAN_ADDRESS"), agent: need("AGENT_ADDRESS"),
      mother: need("MOTHER_ADDRESS"), school: need("SCHOOL_ADDRESS"), attacker: env("ATTACKER_ADDRESS", deployer.account.address),
      employer: env("EMPLOYER_ADDRESS", deployer.account.address),
    };
  }
  console.log(`Deploying to ${network} (chain ${chainId}) as ${deployer.account.address}`);

  const wait = (hash) => publicClient.waitForTransactionReceipt({ hash });
  const startBlock = await publicClient.getBlockNumber();

  const USDC = await hre.viem.deployContract("MockStable", ["Covenant Test USD", "USDC"]);
  const EURC = await hre.viem.deployContract("MockStable", ["Covenant Test EUR", "EURC"]);
  const usdcFeed = await hre.viem.deployContract("MockAggregator", ["USDC / USD (mock)", 100000000n]);
  const eurcFeed = await hre.viem.deployContract("MockAggregator", ["EURC / USD (mock)", 108000000n]);
  const amm = await hre.viem.deployContract("MockAmm");
  const lending = await hre.viem.deployContract("MockLendingPool", [400n]);
  const registry = await hre.viem.deployContract("ReceiptRegistry");
  const factory = await hre.viem.deployContract("VaultFactory");
  console.log("contracts deployed");

  // Liquidity and reserves
  await wait(await USDC.write.mint([deployer.account.address, units(1_000_000)]));
  await wait(await EURC.write.mint([deployer.account.address, units(1_000_000)]));
  await wait(await USDC.write.approve([amm.address, units(500_000)]));
  await wait(await EURC.write.approve([amm.address, units(462_962.962962)]));
  await wait(await amm.write.addLiquidity([USDC.address, EURC.address, units(500_000), units(462_962.962962)]));
  await wait(await USDC.write.transfer([lending.address, units(20_000)]));
  await wait(await USDC.write.mint([addr.employer, units(100_000)]));

  // Mandate → hash
  const template = readFileSync(path.join(shared, "mandates", "demo.template.json"), "utf8")
    .replaceAll("${OWNER}", addr.owner).replaceAll("${GUARDIAN}", addr.guardian)
    .replaceAll("${MOTHER}", addr.mother).replaceAll("${SCHOOL}", addr.school);
  const mandate = Mandate.parse(JSON.parse(template));
  const mandateHash = hashCanonical(mandate);
  mkdirSync(path.join(shared, "mandates"), { recursive: true });
  writeFileSync(path.join(shared, "mandates", `${network}.json`), JSON.stringify(mandate, null, 2) + "\n");

  const now = BigInt((await publicClient.getBlock()).timestamp);
  const day = 86400;
  const cfg = {
    owner: addr.owner,
    guardian: addr.guardian,
    agent: addr.agent,
    agentExpiresAt: now + BigInt(env("AGENT_TTL_DAYS", "30")) * 86400n,
    router: amm.address,
    lendingPool: lending.address,
    coolingOff: Number(env("COOLING_OFF_SEC", day)),
    timelockDelay: Number(env("TIMELOCK_SEC", 3600)),
    proposalTtl: day,
    maxSlippageBps: 50,
    depegBps: 200,
    maxOracleStaleness: Number(env("ORACLE_STALENESS_SEC", 7 * day)),
    mandateHash,
  };
  const L = mandate.limits;
  const policy = (oracle, isStable) => ({
    allowed: true, isStable,
    perTxCap: units(L.perTx), dailyCap: units(L.daily), t2Ceiling: units(L.t2Ceiling),
    dailySwapCap: units(500), lendingCap: units(1000), oracle,
  });
  const payees = mandate.payees.map((p) => ({ id: payeeId(p.alias), wallet: p.address, labelHash: labelId(`${p.alias} — ${p.purpose}`) }));

  const factoryAsOwner = await hre.viem.getContractAt("VaultFactory", factory.address, { client: { wallet: owner } });
  const createHash = await factoryAsOwner.write.createVault([
    cfg, payees, [USDC.address, EURC.address],
    [policy(usdcFeed.address, true), policy(eurcFeed.address, false)],
    [[USDC.address, EURC.address], [EURC.address, USDC.address]],
  ]);
  await wait(createHash);
  const vaults = await factory.read.vaultsOf([addr.owner]);
  const vault = vaults[vaults.length - 1];
  console.log(`vault ${vault} created by owner (tx ${createHash})`);

  const deployment = {
    network, chainId, startBlock: Number(startBlock), deployedAt: new Date().toISOString(),
    contracts: {
      vault, vaultFactory: factory.address, vaultImplementation: await factory.read.implementation(),
      receiptRegistry: registry.address, usdc: USDC.address, eurc: EURC.address,
      usdcOracle: usdcFeed.address, eurcOracle: eurcFeed.address, amm: amm.address, lendingPool: lending.address,
    },
    accounts: addr,
    params: { ...cfg, agentExpiresAt: cfg.agentExpiresAt.toString() },
    buckets: BUCKETS,
    payees: mandate.payees.map((p) => ({ alias: p.alias, id: payeeId(p.alias), address: p.address })),
    mandateHash,
    setupTxs: [{ hash: createHash, kind: "createVault", scenario: "D1" }],
    mocks: ["usdc", "eurc", "usdcOracle", "eurcOracle", "amm", "lendingPool"],
  };
  mkdirSync(path.join(shared, "deployments"), { recursive: true });
  writeFileSync(path.join(shared, "deployments", `${network}.json`), JSON.stringify(deployment, null, 2) + "\n");
  console.log(`wrote shared/deployments/${network}.json`);

  if (!local && process.env.ETHERSCAN_API_KEY) {
    for (const [name, address, args] of [
      ["VaultFactory", factory.address, []], ["ReceiptRegistry", registry.address, []],
      ["MockAmm", amm.address, []], ["MockLendingPool", lending.address, [400n]],
    ]) {
      try {
        await hre.run("verify:verify", { address, constructorArguments: args });
      } catch (e) {
        console.warn(`verify ${name}: ${e.message}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
