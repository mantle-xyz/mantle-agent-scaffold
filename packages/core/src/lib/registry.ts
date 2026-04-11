import { getAddress } from "viem";
import registry from "../config/registry.json" with { type: "json" };
import type { Network } from "../types.js";

export interface RegistryEntry {
  key: string;
  label: string;
  environment: "mainnet" | "testnet";
  category: "system" | "token" | "bridge" | "defi";
  address: string;
  status: "active" | "deprecated" | "paused" | "unknown";
  is_official: boolean;
  aliases?: string[];
  source?: {
    url?: string;
    retrieved_at?: string;
  };
}

interface RegistryJson {
  schema_version: string;
  network: string;
  updated_at: string;
  contracts: RegistryEntry[];
}

const registryData = registry as RegistryJson;

export function getRegistryData(): RegistryJson {
  return registryData;
}

export function listRegistryEntries(network: Network): RegistryEntry[] {
  // Registry schema keeps legacy "testnet" naming; tool layer exposes "sepolia".
  const environment = network === "sepolia" ? "testnet" : "mainnet";
  return registryData.contracts.filter((entry) => entry.environment === environment);
}

export function findRegistryByAddress(network: Network, address: string): RegistryEntry | null {
  const normalized = getAddress(address);
  const entries = listRegistryEntries(network);
  for (const entry of entries) {
    if (getAddress(entry.address) === normalized) {
      return entry;
    }
  }
  return null;
}
