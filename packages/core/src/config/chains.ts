import type { Network } from "../types.js";

export interface ChainConfig {
  chain_id: number;
  name: string;
  native_token: { symbol: string; decimals: number };
  rpc_url: string;
  ws_url: string | null;
  explorer_url: string;
  bridge_url: string;
  recommended_solidity_compiler: string;
  wrapped_mnt: string;
  faucet_urls?: string[];
}

export const CHAIN_CONFIGS: Record<Network, ChainConfig> = {
  mainnet: {
    chain_id: 5000,
    name: "Mantle",
    native_token: { symbol: "MNT", decimals: 18 },
    rpc_url: "https://rpc.mantle.xyz",
    ws_url: "wss://rpc.mantle.xyz",
    explorer_url: "https://mantlescan.xyz",
    bridge_url: "https://app.mantle.xyz/bridge",
    recommended_solidity_compiler: "v0.8.23 or below",
    wrapped_mnt: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8"
  },
  sepolia: {
    chain_id: 5003,
    name: "Mantle Sepolia",
    native_token: { symbol: "MNT", decimals: 18 },
    rpc_url: "https://rpc.sepolia.mantle.xyz",
    ws_url: null,
    explorer_url: "https://sepolia.mantlescan.xyz",
    bridge_url: "https://app.mantle.xyz/bridge?network=sepolia",
    faucet_urls: [
      "https://faucet.sepolia.mantle.xyz/",
      "https://faucet.quicknode.com/mantle/sepolia",
      "https://thirdweb.com/mantle-sepolia-testnet/faucet"
    ],
    recommended_solidity_compiler: "v0.8.23 or below",
    wrapped_mnt: "0x19f5557E23e9914A18239990f6C70D68FDF0deD5"
  }
};
