import hre from "hardhat";
import { keccak256, toHex, parseUnits, zeroAddress, getAddress } from "viem";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";

export const id = (s) => keccak256(toHex(s));
export const usdc = (n) => parseUnits(String(n), 6);
export const B = { FAMILY: id("FAMILY"), EMERGENCY: id("EMERGENCY"), SAVINGS: id("SAVINGS") };
export const P = { MOTHER: id("payee:mother"), SCHOOL: id("payee:school"), SCAMMER: id("payee:customs") };
export const HOUR = 3600n;
export const DAY = 86400n;
export const INTENT = id("intent");

/** Assert that a promise rejects with the given custom error (or revert string). */
export async function expectRevert(promise, name) {
  try {
    await promise;
  } catch (e) {
    const parts = [];
    for (let c = e, depth = 0; c && depth < 8; c = c.cause, depth++) {
      parts.push(c.message, c.shortMessage, c.details, c.data?.errorName, c.reason);
    }
    const text = parts.filter(Boolean).join(" | ");
    expect(text, `expected revert ${name}`).to.include(name);
    return e;
  }
  expect.fail(`expected revert ${name}, but the call succeeded`);
}

export const defaultPolicy = (oracle, over = {}) => ({
  allowed: true,
  isStable: true,
  perTxCap: usdc(250),
  dailyCap: usdc(300),
  t2Ceiling: usdc(1000),
  dailySwapCap: usdc(500),
  lendingCap: usdc(1000),
  oracle,
  ...over,
});

/** Deploy the full local stack: tokens, oracles, AMM with liquidity, lending pool, factory, vault. */
export async function deployStack({ coolingOff = Number(DAY), timelockDelay = Number(HOUR), fund = 1000 } = {}) {
  const [deployer, owner, guardian, agent, mother, school, attacker, employer] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  const USDC = await hre.viem.deployContract("MockStable", ["Mock USD Coin", "USDC"]);
  const EURC = await hre.viem.deployContract("MockStable", ["Mock Euro Coin", "EURC"]);
  const usdcFeed = await hre.viem.deployContract("MockAggregator", ["USDC / USD", 100000000n]);
  const eurcFeed = await hre.viem.deployContract("MockAggregator", ["EURC / USD", 108000000n]);
  const amm = await hre.viem.deployContract("MockAmm");
  const lending = await hre.viem.deployContract("MockLendingPool", [400n]);
  const registry = await hre.viem.deployContract("ReceiptRegistry");
  const factory = await hre.viem.deployContract("VaultFactory");

  // Liquidity: 100k USDC vs 92.6k EURC (≈ 1.08 USD per EUR)
  for (let i = 0; i < 2; i++) {
    await USDC.write.mint([deployer.account.address, usdc(1000000)]);
    await EURC.write.mint([deployer.account.address, usdc(1000000)]);
  }
  await USDC.write.approve([amm.address, usdc(1000000)]);
  await EURC.write.approve([amm.address, usdc(925925.925925)]);
  await amm.write.addLiquidity([USDC.address, EURC.address, usdc(1000000), usdc(925925.925925)]);
  await USDC.write.transfer([lending.address, usdc(10000)]); // interest reserve

  const now = BigInt(await time.latest());
  const cfg = {
    owner: owner.account.address,
    guardian: guardian.account.address,
    agent: agent.account.address,
    agentExpiresAt: now + 365n * DAY,
    router: amm.address,
    lendingPool: lending.address,
    coolingOff,
    timelockDelay,
    proposalTtl: Number(DAY),
    maxSlippageBps: 50,
    depegBps: 200,
    maxOracleStaleness: Number(DAY),
    mandateHash: id("mandate-v1"),
  };
  const payees = [
    { id: P.MOTHER, wallet: mother.account.address, labelHash: id("Mother — family support") },
    { id: P.SCHOOL, wallet: school.account.address, labelHash: id("Children's school") },
  ];
  const assets = [USDC.address, EURC.address];
  // The depeg rule applies to USD stablecoins; EURC is priced in USD and floats with EUR/USD.
  const policies = [defaultPolicy(usdcFeed.address), defaultPolicy(eurcFeed.address, { isStable: false })];
  const pairs = [
    [USDC.address, EURC.address],
    [EURC.address, USDC.address],
  ];

  const factoryAsOwner = await hre.viem.getContractAt("VaultFactory", factory.address, { client: { wallet: owner } });
  const hash = await factoryAsOwner.write.createVault([cfg, payees, assets, policies, pairs]);
  await publicClient.waitForTransactionReceipt({ hash });
  const [vaultAddress] = await factory.read.vaultsOf([owner.account.address]);

  const as = async (wallet) => hre.viem.getContractAt("PolicyVault", vaultAddress, { client: { wallet } });
  const vault = await as(agent);
  const vaultOwner = await as(owner);
  const vaultGuardian = await as(guardian);
  const vaultAttacker = await as(attacker);

  if (fund > 0) await USDC.write.mint([vaultAddress, usdc(fund)]);

  return {
    hre, publicClient, deployer, owner, guardian, agent, mother, school, attacker, employer,
    USDC, EURC, usdcFeed, eurcFeed, amm, lending, registry, factory, cfg,
    vault, vaultOwner, vaultGuardian, vaultAttacker, vaultAddress: getAddress(vaultAddress), as,
  };
}

export { time, expect, zeroAddress };
