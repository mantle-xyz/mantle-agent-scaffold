import { getAddress, isAddress } from "viem";
import { MantleMcpError } from "../errors.js";
import { MANTLE_TOKENS, type TokenEntry } from "../config/tokens.js";
import { getPublicClient } from "./clients.js";
import { ERC20_ABI } from "./abis/erc20.js";
import type { Network } from "../types.js";

export interface ResolvedTokenInput {
  address: string;
  symbol: string | null;
  decimals: number | null;
  name?: string | null;
}

function findByAddress(network: Network, address: string): TokenEntry | null {
  const wanted = getAddress(address);
  const entries = Object.values(MANTLE_TOKENS[network]);
  for (const entry of entries) {
    if (entry.address !== "native" && getAddress(entry.address) === wanted) {
      return entry;
    }
  }
  return null;
}

function findBySymbol(network: Network, symbol: string): TokenEntry | null {
  const key = Object.keys(MANTLE_TOKENS[network]).find(
    (candidate) => candidate.toLowerCase() === symbol.toLowerCase()
  );
  return key ? MANTLE_TOKENS[network][key] : null;
}

export function resolveTokenInput(identifier: string, network: Network): ResolvedTokenInput | Promise<ResolvedTokenInput> {
  if (isAddress(identifier, { strict: false })) {
    const checksummed = getAddress(identifier);
    const entry = findByAddress(network, checksummed);
    if (entry) {
      return {
        address: checksummed,
        symbol: entry.symbol,
        decimals: entry.decimals,
        name: entry.name
      };
    }
    // Not in registry — on-chain fallback
    return resolveOnChain(checksummed, network);
  }

  const entry = findBySymbol(network, identifier);
  if (!entry) {
    throw new MantleMcpError(
      "TOKEN_NOT_FOUND",
      `Unknown token: ${identifier}`,
      "Use a known token symbol from mantle://registry/tokens or provide a token address.",
      { token: identifier, network }
    );
  }

  return {
    address: entry.address,
    symbol: entry.symbol,
    decimals: entry.decimals,
    name: entry.name
  };
}

/**
 * On-chain fallback: read decimals/symbol/name from the ERC-20 contract.
 * Used when a caller provides a raw address not present in the static registry.
 */
async function resolveOnChain(address: string, network: Network): Promise<ResolvedTokenInput> {
  const client = getPublicClient(network);
  const addr = address as `0x${string}`;

  // decimals is critical — symbol and name are best-effort
  const [decimals, symbol, name] = await Promise.all([
    client
      .readContract({ address: addr, abi: ERC20_ABI, functionName: "decimals" })
      .catch(() => null),
    client
      .readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" })
      .catch(() => null),
    client
      .readContract({ address: addr, abi: ERC20_ABI, functionName: "name" })
      .catch(() => null)
  ]);

  return {
    address,
    symbol: typeof symbol === "string" ? symbol : null,
    decimals: typeof decimals === "number" ? decimals : null,
    name: typeof name === "string" ? name : null
  };
}

export function findTokenBySymbol(network: Network, symbol: string): TokenEntry | null {
  return findBySymbol(network, symbol);
}
