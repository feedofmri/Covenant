// Minimal injected-wallet provider on viem (EIP-1193). Replaces wagmi to keep dependencies permissively licensed.
import { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import { createWalletClient, createPublicClient, custom, http } from "viem";
import { baseSepolia, hardhat } from "viem/chains";

const CHAINS = { [baseSepolia.id]: baseSepolia, [hardhat.id]: hardhat };
const RPC = { [baseSepolia.id]: "https://sepolia.base.org", [hardhat.id]: "http://127.0.0.1:8545" };
const WalletContext = createContext(null);

export function WalletProvider({ chainId: wantedChainId, children }) {
  const eth = typeof window !== "undefined" ? window.ethereum : undefined;
  const [address, setAddress] = useState(null);
  const [chainId, setChainId] = useState(null);

  useEffect(() => {
    if (!eth) return;
    eth.request({ method: "eth_accounts" }).then((a) => setAddress(a[0] ?? null)).catch(() => {});
    eth.request({ method: "eth_chainId" }).then((c) => setChainId(Number(c))).catch(() => {});
    const onAccounts = (a) => setAddress(a[0] ?? null);
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
  const walletClient = useMemo(() => (eth && address ? createWalletClient({ account: address, chain, transport: custom(eth) }) : null), [eth, address, chain]);

  const connect = useCallback(async () => {
    if (!eth) throw new Error("No browser wallet found. Install MetaMask or open this page in a wallet browser.");
    const accounts = await eth.request({ method: "eth_requestAccounts" });
    setAddress(accounts[0] ?? null);
    if (wantedChainId && Number(await eth.request({ method: "eth_chainId" })) !== wantedChainId) {
      try {
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${wantedChainId.toString(16)}` }] });
      } catch {
        await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: `0x${chain.id.toString(16)}`, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: [RPC[chain.id]] }] });
      }
    }
  }, [eth, wantedChainId, chain]);

  const value = { address, chainId, chain, isConnected: Boolean(address), connect, disconnect: () => setAddress(null), walletClient, publicClient, hasWallet: Boolean(eth) };
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
