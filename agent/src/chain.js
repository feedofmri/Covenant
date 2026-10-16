// Chain access: a public client with fallback RPCs and the agent's wallet client (the session key).
import { createPublicClient, createWalletClient, fallback, http, defineChain, getContract } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base, hardhat } from "viem/chains";
import { loadDeployment, loadAbi } from "@covenant/shared";

const KNOWN = { 84532: baseSepolia, 8453: base, 31337: hardhat };

export function chainFor(chainId, rpcUrl) {
  return KNOWN[chainId] ?? defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
}

export function createChainContext(config, deployment = loadDeployment(config.deployment)) {
  const chain = chainFor(deployment.chainId, config.rpcUrls[0]);
  const transport = config.rpcUrls.length > 1 ? fallback(config.rpcUrls.map((u) => http(u, { timeout: 15000 }))) : http(config.rpcUrls[0], { timeout: 15000 });
  const publicClient = createPublicClient({ chain, transport, pollingInterval: deployment.chainId === 31337 ? 200 : 2000 });
  const account = config.agentPrivateKey ? privateKeyToAccount(config.agentPrivateKey) : null;
  const walletClient = account ? createWalletClient({ account, chain, transport }) : null;

  const abis = {
    vault: loadAbi("PolicyVault"),
    registry: loadAbi("ReceiptRegistry"),
    erc20: loadAbi("MockStable"),
    oracle: loadAbi("MockAggregator"),
    amm: loadAbi("MockAmm"),
    lending: loadAbi("MockLendingPool"),
  };
  const c = deployment.contracts;
  const client = { public: publicClient, wallet: walletClient ?? undefined };
  return {
    chain,
    deployment,
    publicClient,
    walletClient,
    account,
    abis,
    vault: getContract({ address: c.vault, abi: abis.vault, client }),
    registry: getContract({ address: c.receiptRegistry, abi: abis.registry, client }),
    tokens: {
      USDC: { symbol: "USDC", address: c.usdc, oracle: c.usdcOracle, contract: getContract({ address: c.usdc, abi: abis.erc20, client }) },
      EURC: { symbol: "EURC", address: c.eurc, oracle: c.eurcOracle, contract: getContract({ address: c.eurc, abi: abis.erc20, client }) },
    },
  };
}

export function symbolOf(ctx, address) {
  const t = Object.values(ctx.tokens).find((t) => t.address.toLowerCase() === address.toLowerCase());
  return t?.symbol ?? address;
}
