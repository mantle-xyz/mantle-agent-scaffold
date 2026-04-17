import { formatUnits } from "viem";
import { z } from "zod";
import { MantleMcpError } from "../errors.js";
import { getPublicClient } from "../lib/clients.js";
import { ERC20_ABI } from "../lib/abis/erc20.js";
import { normalizeNetwork } from "../lib/network.js";
import { fetchTokenListSnapshot, type TokenListSnapshot } from "../lib/token-list.js";
import {
  findTokenBySymbol,
  resolveTokenInput as resolveTokenFromQuickRef,
  type ResolvedTokenInput
} from "../lib/token-registry.js";
import { CHAIN_CONFIGS } from "../config/chains.js";
import type { Tool } from "../types.js";

interface TokenDeps {
  getClient: (network: "mainnet" | "sepolia") => any;
  now: () => string;
  resolveTokenInput: (
    token: string,
    network?: "mainnet" | "sepolia"
  ) => Promise<ResolvedTokenInput> | ResolvedTokenInput;
  readTokenMetadata: (
    client: any,
    tokenAddress: string
  ) => Promise<{ name: string | null; symbol: string | null; decimals: number | null; totalSupply: bigint | null }>;
  fetchTokenListSnapshot: () => Promise<TokenListSnapshot>;
}

const DEXSCREENER_API_BASE = "https://api.dexscreener.com";
const DEFILLAMA_PRICES_API_BASE = "https://coins.llama.fi/prices/current";

/* ------------------------------------------------------------------ */
/*  Zod schemas for external API responses                            */
/* ------------------------------------------------------------------ */

/**
 * DexScreener /tokens/v1/:chain/:address returns an array of pair objects.
 * priceUsd is optional/nullable: DexScreener returns it as a string ("1.23"),
 * and illiquid pairs may omit it — null is the intended degraded path via
 * asFiniteNumber().
 */
const DexScreenerPairSchema = z.object({
  priceUsd: z
    .union([z.string(), z.number()])
    .optional()
    .nullable()
});

const DexScreenerResponseSchema = z.array(DexScreenerPairSchema).min(1);

/** DefiLlama /prices/current/:coins returns { coins: { "chain:address": { price } } }. */
const DefiLlamaTokenPriceSchema = z.object({
  price: z
    .number()
    .finite()
    .optional()
    .nullable()
});

const DefiLlamaResponseSchema = z.object({
  coins: z.record(z.string(), DefiLlamaTokenPriceSchema)
});

const defaultDeps: TokenDeps = {
  getClient: getPublicClient,
  now: () => new Date().toISOString(),
  resolveTokenInput: (token, network) => resolveTokenFromQuickRef(token, network ?? "mainnet"),
  readTokenMetadata: async (client, tokenAddress) => {
    const read = async <T>(functionName: string): Promise<T | null> => {
      if (!client.readContract) {
        return null;
      }
      try {
        return (await client.readContract({
          address: tokenAddress as `0x${string}`,
          abi: ERC20_ABI,
          functionName: functionName as never
        })) as T;
      } catch {
        return null;
      }
    };

    const [name, symbol, decimals, totalSupply] = await Promise.all([
      read<string>("name"),
      read<string>("symbol"),
      read<number>("decimals"),
      read<bigint>("totalSupply")
    ]);

    return { name, symbol, decimals, totalSupply };
  },
  fetchTokenListSnapshot
};

function withDeps(overrides?: Partial<TokenDeps>): TokenDeps {
  return {
    ...defaultDeps,
    ...overrides
  };
}

function resolveDexScreenerChain(network: "mainnet" | "sepolia"): string | null {
  if (network === "mainnet") {
    return "mantle";
  }
  return null;
}

function resolveDefiLlamaChain(network: "mainnet" | "sepolia"): string | null {
  if (network === "mainnet") {
    return "mantle";
  }
  return null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function fetchJsonSafe(url: string, timeoutMs = 8000): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDexScreenerTokenPriceUsd(
  network: "mainnet" | "sepolia",
  tokenAddress: string
): Promise<number | null> {
  const chainId = resolveDexScreenerChain(network);
  if (!chainId) {
    return null;
  }

  const payload = await fetchJsonSafe(
    `${DEXSCREENER_API_BASE}/tokens/v1/${chainId}/${tokenAddress}`
  );

  const parsed = DexScreenerResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }

  return asFiniteNumber(parsed.data[0].priceUsd);
}

async function fetchDefiLlamaTokenPrices(
  network: "mainnet" | "sepolia",
  tokenAddresses: string[]
): Promise<Record<string, number | null>> {
  const chainId = resolveDefiLlamaChain(network);
  if (!chainId || tokenAddresses.length === 0) {
    return {};
  }

  const unique = [...new Set(tokenAddresses.map((address) => address.toLowerCase()))];
  const coins = unique.map((address) => `${chainId}:${address}`).join(",");
  const payload = await fetchJsonSafe(`${DEFILLAMA_PRICES_API_BASE}/${coins}`);

  const parsed = DefiLlamaResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return {};
  }

  const record = parsed.data.coins;
  const out: Record<string, number | null> = {};
  for (const address of unique) {
    const key = `${chainId}:${address}`;
    out[address] = asFiniteNumber(record[key]?.price);
  }
  return out;
}

function findTokenInCanonical(
  snapshot: TokenListSnapshot,
  quickRef: { symbol: string; address: string },
  chainId: number
): { address: string; decimals: number; symbol: string } | null {
  // Match primarily by (chainId, address). Address is the authoritative
  // on-chain identity — the canonical list sometimes uses namespaced symbols
  // (e.g. "USDT (BRIDGED)" vs our quick-ref "USDT"), so symbol-only match
  // would produce false TOKEN_REGISTRY_MISMATCH for correctly-addressed
  // tokens.
  const byAddress = snapshot.tokens.find(
    (token) => token.chainId === chainId && token.address.toLowerCase() === quickRef.address.toLowerCase()
  );
  if (byAddress) {
    return { address: byAddress.address, decimals: byAddress.decimals, symbol: byAddress.symbol };
  }

  // Fallback: symbol match. Produces a TOKEN_REGISTRY_MISMATCH downstream if
  // the canonical address at that symbol differs from the quick-ref address.
  const bySymbol = snapshot.tokens.find(
    (token) => token.chainId === chainId && token.symbol.toLowerCase() === quickRef.symbol.toLowerCase()
  );
  if (bySymbol) {
    return { address: bySymbol.address, decimals: bySymbol.decimals, symbol: bySymbol.symbol };
  }

  return null;
}

export async function getTokenInfo(
  args: Record<string, unknown>,
  deps?: Partial<TokenDeps>
): Promise<any> {
  const resolvedDeps = withDeps(deps);
  const { network } = normalizeNetwork(args);
  const tokenInput = typeof args.token === "string" ? args.token : "";
  const resolved = await resolvedDeps.resolveTokenInput(tokenInput, network);
  const client = resolvedDeps.getClient(network);

  if (resolved.address === "native") {
    return {
      address: "native",
      name: "Mantle",
      symbol: "MNT",
      decimals: 18,
      total_supply_raw: null,
      total_supply_normalized: null,
      network,
      collected_at_utc: resolvedDeps.now()
    };
  }

  const metadata = await resolvedDeps.readTokenMetadata(client, resolved.address);
  return {
    address: resolved.address,
    name: metadata.name,
    symbol: metadata.symbol ?? resolved.symbol,
    decimals: metadata.decimals ?? resolved.decimals,
    total_supply_raw: metadata.totalSupply?.toString() ?? null,
    total_supply_normalized:
      metadata.totalSupply != null && metadata.decimals != null
        ? formatUnits(metadata.totalSupply, metadata.decimals)
        : null,
    network,
    collected_at_utc: resolvedDeps.now()
  };
}

export async function getTokenPrices(
  args: Record<string, unknown>,
  deps?: Partial<TokenDeps>
): Promise<any> {
  const resolvedDeps = withDeps(deps);
  const { network } = normalizeNetwork(args);
  const baseCurrency =
    typeof args.base_currency === "string" && args.base_currency.toLowerCase() === "mnt"
      ? "mnt"
      : "usd";
  const tokens = Array.isArray(args.tokens) ? args.tokens.map(String) : [];
  if (tokens.length === 0) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      "At least one token is required.",
      "Provide one or more token symbols or addresses in `tokens`.",
      { field: "tokens" }
    );
  }

  const resolvedInputs = await Promise.all(
    tokens.map(async (input) => {
      // Handle MNT (native gas token) before resolveTokenInput to bypass the
      // WMNT ambiguity warning, which is only relevant for ERC-20 contexts.
      if (input.toLowerCase() === "mnt") {
        try {
          const wrapped = await resolvedDeps.resolveTokenInput("WMNT", network);
          return {
            input,
            resolved: { address: "native" as const, symbol: "MNT", decimals: 18, name: "Mantle" },
            pricingAddress: wrapped.address.toLowerCase(),
            parseError: null as string | null
          };
        } catch (error) {
          return {
            input,
            resolved: null as ResolvedTokenInput | null,
            pricingAddress: null as string | null,
            parseError: error instanceof Error ? error.message : String(error)
          };
        }
      }
      try {
        const token = await resolvedDeps.resolveTokenInput(input, network);
        if (token.address === "native") {
          const wrapped = await resolvedDeps.resolveTokenInput("WMNT", network);
          return {
            input,
            resolved: token,
            pricingAddress: wrapped.address.toLowerCase(),
            parseError: null as string | null
          };
        }

        return {
          input,
          resolved: token,
          pricingAddress: token.address.toLowerCase(),
          parseError: null as string | null
        };
      } catch (error) {
        return {
          input,
          resolved: null as ResolvedTokenInput | null,
          pricingAddress: null as string | null,
          parseError: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );

  const addressesToQuote = new Set<string>();
  for (const item of resolvedInputs) {
    if (item.pricingAddress) {
      addressesToQuote.add(item.pricingAddress);
    }
  }

  let mntPricingAddress: string | null = null;
  if (baseCurrency === "mnt") {
    try {
      const wrapped = await resolvedDeps.resolveTokenInput("WMNT", network);
      mntPricingAddress = wrapped.address.toLowerCase();
      addressesToQuote.add(mntPricingAddress);
    } catch {
      mntPricingAddress = null;
    }
  }

  const quotedAddresses = [...addressesToQuote];
  const usdByAddress: Record<string, number | null> = {};
  const sourceByAddress: Record<string, "dexscreener" | "defillama" | "none"> = {};

  const dexPrices = await Promise.all(
    quotedAddresses.map((address) => fetchDexScreenerTokenPriceUsd(network, address))
  );
  const missing: string[] = [];
  for (let i = 0; i < quotedAddresses.length; i += 1) {
    const address = quotedAddresses[i];
    const price = dexPrices[i];
    if (typeof price === "number") {
      usdByAddress[address] = price;
      sourceByAddress[address] = "dexscreener";
    } else {
      missing.push(address);
    }
  }

  if (missing.length > 0) {
    const fallback = await fetchDefiLlamaTokenPrices(network, missing);
    for (const address of missing) {
      const price = fallback[address] ?? null;
      usdByAddress[address] = price;
      sourceByAddress[address] = typeof price === "number" ? "defillama" : "none";
    }
  }

  const mntUsd =
    mntPricingAddress != null
      ? (usdByAddress[mntPricingAddress] ?? null)
      : null;

  const quotedAt = resolvedDeps.now();
  const prices = resolvedInputs.map((entry) => {
    if (!entry.resolved) {
      return {
        input: entry.input,
        symbol: null,
        address: null,
        price: null,
        source: "none" as const,
        confidence: "low" as const,
        quoted_at_utc: quotedAt,
        warnings: [entry.parseError ?? "Token could not be resolved."]
      };
    }

    const symbol = entry.resolved.symbol;
    const address = entry.resolved.address;
    const usdPrice = entry.pricingAddress ? (usdByAddress[entry.pricingAddress] ?? null) : null;
    const source = entry.pricingAddress ? sourceByAddress[entry.pricingAddress] ?? "none" : "none";

    if (baseCurrency === "mnt") {
      if (address === "native" || symbol?.toLowerCase() === "mnt" || symbol?.toLowerCase() === "wmnt") {
        return {
          input: entry.input,
          symbol,
          address,
          price: 1,
          source: "derived" as const,
          confidence: "high" as const,
          quoted_at_utc: quotedAt,
          warnings: []
        };
      }
      if (usdPrice == null || mntUsd == null || mntUsd <= 0) {
        return {
          input: entry.input,
          symbol,
          address,
          price: null,
          source,
          confidence: "low" as const,
          quoted_at_utc: quotedAt,
          warnings: ["MNT quote currency conversion unavailable."]
        };
      }
      return {
        input: entry.input,
        symbol,
        address,
        price: usdPrice / mntUsd,
        source,
        confidence: source === "dexscreener" ? "high" as const : "medium" as const,
        quoted_at_utc: quotedAt,
        warnings: []
      };
    }

    return {
      input: entry.input,
      symbol,
      address,
      price: usdPrice,
      source,
      confidence:
        usdPrice == null ? ("low" as const) : source === "dexscreener" ? ("high" as const) : ("medium" as const),
      quoted_at_utc: quotedAt,
      warnings: usdPrice == null ? ["No trusted valuation backend returned this token price."] : []
    };
  });

  return {
    base_currency: baseCurrency,
    prices,
    partial: prices.some((entry) => entry.price === null),
    warnings:
      prices.some((entry) => entry.price === null)
        ? ["Prices are null when a trusted source is unavailable. Values are never fabricated."]
        : [],
    network
  };
}

export async function resolveToken(
  args: Record<string, unknown>,
  deps?: Partial<TokenDeps>
): Promise<any> {
  const resolvedDeps = withDeps(deps);
  const { network } = normalizeNetwork(args);
  const symbol = typeof args.symbol === "string" ? args.symbol : "";
  const requireTokenListMatch = args.require_token_list_match !== false;

  const quickRef = findTokenBySymbol(network, symbol);
  if (!quickRef) {
    throw new MantleMcpError(
      "TOKEN_NOT_FOUND",
      `Unknown token symbol: ${symbol}`,
      "Use mantle://registry/tokens to discover supported symbols.",
      { symbol, network }
    );
  }

  const warnings: string[] = [];
  let tokenListChecked = false;
  let tokenListMatch: boolean | null = null;
  let tokenListAddress: string | null = null;
  let tokenListVersion: string | null = null;
  let source: "quick_ref" | "token_list" | "both" = "quick_ref";
  let confidence: "high" | "medium" | "low" = "high";

  if (quickRef.address !== "native") {
    try {
      const snapshot = await resolvedDeps.fetchTokenListSnapshot();
      tokenListChecked = true;
      tokenListVersion = snapshot.version;
      const canonical = findTokenInCanonical(snapshot, quickRef, CHAIN_CONFIGS[network].chain_id);

      if (!canonical) {
        tokenListMatch = false;
        if (requireTokenListMatch) {
          throw new MantleMcpError(
            "TOKEN_REGISTRY_MISMATCH",
            `Token ${quickRef.symbol} missing from canonical token list.`,
            "Retry later or provide a token confirmed by the canonical token list.",
            { symbol: quickRef.symbol, network, token_list_version: tokenListVersion }
          );
        }
        confidence = "low";
        warnings.push("Token not present in canonical token list snapshot.");
      } else {
        tokenListAddress = canonical.address;
        tokenListMatch =
          canonical.address.toLowerCase() === quickRef.address.toLowerCase() &&
          canonical.decimals === quickRef.decimals;
        if (!tokenListMatch) {
          throw new MantleMcpError(
            "TOKEN_REGISTRY_MISMATCH",
            `Token registry mismatch for ${quickRef.symbol}.`,
            "Stop execution and verify the token contract address from canonical sources.",
            {
              symbol: quickRef.symbol,
              quick_ref_address: quickRef.address,
              token_list_address: canonical.address,
              quick_ref_decimals: quickRef.decimals,
              token_list_decimals: canonical.decimals
            }
          );
        }
        source = "both";
        confidence = "high";
      }
    } catch (error) {
      if (error instanceof MantleMcpError) {
        throw error;
      }
      if (requireTokenListMatch) {
        throw new MantleMcpError(
          "TOKEN_LIST_UNAVAILABLE",
          "Canonical token list is unavailable.",
          "Retry when token-list endpoint is reachable or configure a valid token-list URL.",
          { retryable: true, raw_error: error instanceof Error ? error.message : String(error) }
        );
      }
      warnings.push("Token list unavailable. Returning quick-reference result with low confidence.");
      confidence = "low";
      tokenListChecked = false;
      tokenListMatch = null;
    }
  } else {
    tokenListChecked = false;
    tokenListMatch = null;
    tokenListVersion = null;
    warnings.push("Native token resolution does not require token-list validation.");
  }

  return {
    input: symbol,
    symbol: quickRef.symbol,
    address: quickRef.address,
    decimals: quickRef.decimals,
    source,
    token_list_checked: tokenListChecked,
    token_list_match: tokenListMatch,
    token_list_address: tokenListAddress,
    token_list_version: tokenListVersion,
    confidence,
    network,
    warnings
  };
}

export const tokenTools: Record<string, Tool> = {
  getTokenInfo: {
    name: "mantle_getTokenInfo",
    description:
      "Read ERC-20 token metadata (name, symbol, decimals, total supply). Examples: token='USDC' -> 0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9, token='WETH' -> 0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Token symbol or address." },
        network: { type: "string", enum: ["mainnet", "sepolia"], description: "Network." }
      },
      required: ["token"]
    },
    handler: getTokenInfo
  },
  getTokenPrices: {
    name: "mantle_getTokenPrices",
    description:
      "Read token prices for valuation workflows; returns null when no trusted source exists. Examples: tokens=['USDC','WMNT'] on mainnet (0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9, 0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8).",
    inputSchema: {
      type: "object",
      properties: {
        tokens: { type: "array", description: "Token symbols or addresses." },
        base_currency: { type: "string", enum: ["usd", "mnt"], description: "Quote currency." },
        network: { type: "string", enum: ["mainnet", "sepolia"], description: "Network." }
      },
      required: ["tokens"]
    },
    handler: getTokenPrices
  },
  resolveToken: {
    name: "mantle_resolveToken",
    description:
      "Resolve token symbol using quick reference plus canonical token-list cross-check. Examples: symbol='USDC' -> 0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9, symbol='mETH' -> 0xcDA86A272531e8640cD7F1a92c01839911B90bb0.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Token symbol to resolve." },
        network: { type: "string", enum: ["mainnet", "sepolia"], description: "Network." },
        require_token_list_match: {
          type: "boolean",
          description: "Require canonical token-list match (default true)."
        }
      },
      required: ["symbol"]
    },
    handler: resolveToken
  }
};
