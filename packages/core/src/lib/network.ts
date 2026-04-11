import type { Network } from "../types.js";
import { MantleMcpError } from "../errors.js";

const NETWORKS = new Set<Network>(["mainnet", "sepolia"]);

export function normalizeNetwork(
  args: Record<string, unknown>,
  options?: { allowLegacyEnvironment?: boolean }
): { network: Network; warnings: string[] } {
  const warnings: string[] = [];
  const allowLegacyEnvironment = options?.allowLegacyEnvironment ?? false;

  let rawNetwork = args.network;
  if (rawNetwork == null && allowLegacyEnvironment) {
    rawNetwork = args.environment;
  }

  const normalized = (typeof rawNetwork === "string" ? rawNetwork : "mainnet").toLowerCase();
  let networkValue = normalized;

  if (allowLegacyEnvironment && normalized === "testnet") {
    networkValue = "sepolia";
    warnings.push("'testnet' is deprecated; use 'sepolia'.");
  }

  if (!NETWORKS.has(networkValue as Network)) {
    throw new MantleMcpError(
      "UNSUPPORTED_NETWORK",
      `Unsupported network: ${String(rawNetwork ?? "unknown")}`,
      "Use one of: mainnet, sepolia.",
      { network: rawNetwork ?? null }
    );
  }

  return { network: networkValue as Network, warnings };
}
