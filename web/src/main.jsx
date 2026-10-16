import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { WalletProvider } from "./lib/wallet.jsx";
import { api } from "./lib/api.js";
import App from "./App.jsx";
import "./index.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchInterval: 5000, retry: 1 } } });

function Root() {
  const { data: dep } = useQuery({ queryKey: ["deployment"], queryFn: api.deployment, refetchInterval: false });
  return (
    <WalletProvider chainId={dep?.chainId}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </WalletProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </React.StrictMode>,
);
