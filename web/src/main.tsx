import React from "react";
import { createRoot } from "react-dom/client";
import { createConfig, http, WagmiProvider } from "wagmi";
import { injected } from "@wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createPublicClient } from "viem";
import App from "./ui/App";

const monadTestnet = {
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://testnet-rpc.monad.xyz"] },
    public: { http: ["https://testnet-rpc.monad.xyz"] },
  },
} as const;

const config = createConfig({
  chains: [monadTestnet],
  ssr: true,
  connectors: [injected()],
  transports: { [monadTestnet.id]: http(monadTestnet.rpcUrls.default.http[0]) },
});

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
);
