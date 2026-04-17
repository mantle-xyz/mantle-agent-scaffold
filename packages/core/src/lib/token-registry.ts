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

/**
 * Tokens whose symbol is ambiguous on Mantle — the user could mean different
 * on-chain assets depending on context (swap vs Aave, DEX routing, etc.).
 * When the caller provides one of these symbols without an explicit address,
 * we surface a disambiguation error instead of silently picking the first match.
 *
 * Format: { userInput: [canonicalSymbol1, canonicalSymbol2, ...] }
 */
const AMBIGUOUS_TOKENS: Record<string, string[]> = {
  // USDT (bridged, DEX only) vs USDT0 (LayerZero OFT, DEX + Aave V3)
  USDT: ["USDT", "USDT0"],
  // User says "ETH" but Mantle only has WETH (ERC-20); native ETH does not exist
  ETH: ["WETH"],
  // MNT is the native gas token; WMNT is the ERC-20 needed for swaps/approvals
  MNT: ["MNT", "WMNT"],
  // "transfer" is semantically ambiguous — native vs ERC-20 use different CLI commands
  TRANSFER: ["send-native (for MNT)", "send-token (for ERC-20)"]
};

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

/**
 * Build a human-readable disambiguation question for an ambiguous token symbol.
 */
function formatDisambiguationQuestion(identifier: string, candidates: string[]): string {
  const candidateList = candidates.join(", ");
  if (identifier.toUpperCase() === "USDT") {
    return (
      `"${identifier}" matches multiple tokens on Mantle: USDT (bridged Tether, DEX only) ` +
      `or USDT0 (LayerZero OFT, works on DEX AND Aave V3). ` +
      `Which one did you mean? If you need to interact with Aave, you must use USDT0.`
    );
  }
  if (identifier.toUpperCase() === "ETH") {
    return (
      `"${identifier}" does not exist as a native token on Mantle. ` +
      `Did you mean WETH (Wrapped Ether, ERC-20)?`
    );
  }
  if (identifier.toUpperCase() === "MNT") {
    return (
      `"${identifier}" is the native gas token (MNT) on Mantle. ` +
      `For swaps, approvals, and DeFi operations you typically need WMNT (Wrapped Mantle, ERC-20). ` +
      `Which one did you mean?`
    );
  }
  return `"${identifier}" matches multiple tokens on Mantle: ${candidateList}. Which one did you mean?`;
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

  // ── Ambiguity check ─────────────────────────────────────────────────────
  const ambiguousCandidates = AMBIGUOUS_TOKENS[identifier.toUpperCase()];
  if (ambiguousCandidates && ambiguousCandidates.length > 1) {
    // Fetch details for candidates that exist in the registry
    const candidateDetails = ambiguousCandidates
      .map((sym) => {
        const entry = findBySymbol(network, sym);
        return entry
          ? { symbol: entry.symbol, address: entry.address, name: entry.name }
          : { symbol: sym, address: "N/A", name: sym };
      });

    throw new MantleMcpError(
      "AMBIGUOUS_TOKEN",
      `"${identifier}" matches multiple tokens on Mantle.`,
      "Ask the user to confirm which token they meant.",
      { identifier, candidates: candidateDetails },
      {
        requiresUserInput: true,
        questionForUser: formatDisambiguationQuestion(identifier, ambiguousCandidates),
        doNot: [
          "DO NOT pick one without user confirmation",
          "DO NOT guess a different token address",
          "DO NOT proceed without knowing the exact token"
        ]
      }
    );
  }

  // ── Normal symbol lookup ─────────────────────────────────────────────────
  const entry = findBySymbol(network, identifier);
  if (!entry) {
    const knownSymbols = Object.keys(MANTLE_TOKENS[network]);

    throw new MantleMcpError(
      "TOKEN_NOT_FOUND",
      `Unknown token: ${identifier}`,
      "Ask the user which token they meant. Available tokens are listed in available_options.",
      { token: identifier, network },
      {
        requiresUserInput: true,
        questionForUser:
          `Token "${identifier}" not found on Mantle ${network}. ` +
          `Available tokens: ${knownSymbols.join(", ")}. Which one did you mean?`,
        doNot: [
          "DO NOT guess a token address",
          "DO NOT use an address from training data",
          "DO NOT proceed without user confirming the token"
        ]
      }
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
