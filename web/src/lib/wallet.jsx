// Minimal injected-wallet provider on viem (EIP-1193). Replaces wagmi to keep dependencies permissively licensed.
import { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import { createWalletClient, createPublicClient, custom, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, hardhat } from "viem/chains";

const CHAINS = { [baseSepolia.id]: baseSepolia, [hardhat.id]: hardhat };
const RPC = { [baseSepolia.id]: "https://sepolia.base.org", [hardhat.id]: "http://127.0.0.1:8545" };
const WalletContext = createContext(null);

export const DEV_ACCOUNTS = {
  owner: {
    role: "owner",
    label: "Owner (Rahim)",
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  },
  guardian: {
    role: "guardian",
    label: "Guardian (Mother)",
    address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  },
};

export function WalletProvider({ chainId: wantedChainId, children }) {
  const eth = typeof window !== "undefined" ? window.ethereum : undefined;
  const [address, setAddress] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [devKey, setDevKey] = useState(null);
  const [devRole, setDevRole] = useState(null);

  useEffect(() => {
    if (!eth) return;
    eth.request({ method: "eth_accounts" }).then((a) => setAddress(a[0] ?? null)).catch(() => {});
    eth.request({ method: "eth_chainId" }).then((c) => setChainId(Number(c))).catch(() => {});
    const onAccounts = (a) => {
      setDevKey(null);
      setDevRole(null);
      setAddress(a[0] ?? null);
    };
    const onChain = (c) => setChainId(Number(c));
    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [eth]);

  const chain = CHAINS[wantedChainId] ?? hardhat;
  const publicClient = useMemo(() => createPublicClient({ chain, transport: http(RPC[chain.id]) }), [chain]);

  const walletClient = useMemo(() => {
    if (devKey) {
      return createWalletClient({ account: privateKeyToAccount(devKey), chain, transport: http(RPC[chain.id]) });
    }
    if (eth && address) {
      return createWalletClient({ account: address, chain, transport: custom(eth) });
    }
    return null;
  }, [devKey, eth, address, chain]);

  const connectDev = useCallback((role = "owner") => {
    const acc = DEV_ACCOUNTS[role] || DEV_ACCOUNTS.owner;
    setDevKey(acc.privateKey);
    setDevRole(acc.role);
    setAddress(acc.address);
    setChainId(chain.id);
  }, [chain.id]);

  const connect = useCallback(async (preferredRole = "owner") => {
    if (!eth) {
      if (!wantedChainId || wantedChainId === 31337) {
        connectDev(preferredRole);
        return;
      }
      throw new Error("No browser wallet found. Install MetaMask or open this page in a wallet browser.");
    }
    setDevKey(null);
    setDevRole(null);
    const accounts = await eth.request({ method: "eth_requestAccounts" });
    setAddress(accounts[0] ?? null);
    if (wantedChainId && Number(await eth.request({ method: "eth_chainId" })) !== wantedChainId) {
      try {
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${wantedChainId.toString(16)}` }] });
      } catch {
        await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: `0x${chain.id.toString(16)}`, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: [RPC[chain.id]] }] });
      }
    }
  }, [eth, wantedChainId, chain, connectDev]);

  const disconnect = useCallback(() => {
    setDevKey(null);
    setDevRole(null);
    setAddress(null);
  }, []);

  const value = {
    address,
    chainId: chainId ?? chain.id,
    chain,
    isConnected: Boolean(address),
    connect,
    connectDev,
    devRole,
    disconnect,
    walletClient,
    publicClient,
    hasWallet: Boolean(eth),
  };
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const w = useContext(WalletContext);
  if (!w) throw new Error("useWallet outside WalletProvider");
  return w;
}

/** Send a contract call or raw tx and wait for it to be mined. */
export async function sendAndWait(w, req) {
  if (!w.walletClient) throw new Error("Connect your wallet first");
  const hash = req.abi ? await w.walletClient.writeContract(req) : await w.walletClient.sendTransaction(req);
  await w.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
