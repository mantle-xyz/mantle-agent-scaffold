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
const COINGECKO_API_BASE = "https://api.coingecko.com/api/v3";
const COINGECKO_PRO_API_BASE = "https://pro-api.coingecko.com/api/v3";

/* ------------------------------------------------------------------ */
/*  Zod schemas for external API responses                            */
/* ------------------------------------------------------------------ */

/**
 * DexScreener /tokens/v1/:chain/:address returns an array of pair objects.
 * priceUsd is optional/nullable: DexScreener returns it as a string ("1.23"),
 * and illiquid pairs may omit it — null is the intended degraded path via
 * asFiniteNumber().
 * baseToken and liquidity are included so we can pick the deepest market.
 */
const DexScreenerPairSchema = z.object({
  priceUsd: z.union([z.string(), z.number()]).optional().nullable(),
  baseToken: z
    .object({
      address: z.string().optional().nullable(),
      symbol: z.string().optional().nullable()
    })
    .optional()
    .nullable(),
  liquidity: z
    .object({
      usd: z.union([z.string(), z.number()]).optional().nullable()
    })
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

/**
 * CoinGecko /simple/token_price/{platform} returns a map of address → { usd: number }.
 * Addresses in the response key are always lowercased.
 */
const CoinGeckoTokenEntrySchema = z.object({
  usd: z.number().finite().optional().nullable()
});

const CoinGeckoResponseSchema = z.record(z.string(), CoinGeckoTokenEntrySchema);

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
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      if (response.ok) return await response.json();
      // Client errors (4xx) won't be fixed by retrying
      if (response.status >= 400 && response.status < 500) return null;
      // Server errors (5xx) fall through to retry
    } catch {
      // Network error or timeout — fall through to retry
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  return null;
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

  // Prefer pairs where the queried token is the baseToken (price expressed as USD per token).
  // Sort by liquidity.usd descending to use the deepest, most reliable market price.
  const addrLower = tokenAddress.toLowerCase();
  const allPairs = parsed.data;
  const baseMatches = allPairs.filter(
    (p) => p.baseToken?.address?.toLowerCase() === addrLower
  );
  const candidates = baseMatches.length > 0 ? baseMatches : allPairs;

  const sorted = [...candidates].sort((a, b) => {
    const liqA = asFiniteNumber(a.liquidity?.usd) ?? 0;
    const liqB = asFiniteNumber(b.liquidity?.usd) ?? 0;
    return liqB - liqA;
  });

  for (const pair of sorted) {
    const price = asFiniteNumber(pair.priceUsd);
    if (price !== null && price > 0) return price;
  }
  return null;
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

/**
 * Batch-fetch USD prices from CoinGecko for all given token addresses on Mantle.
 *
 * Tier auto-detection via env vars:
 *   - COINGECKO_PRO_API_KEY → use Pro base + `x-cg-pro-api-key` header
 *   - COINGECKO_DEMO_API_KEY or COINGECKO_API_KEY → use public base + `x-cg-demo-api-key` header
 *   - No key → use free public API (no header; subject to 10–30 req/min rate limit)
 *
 * Request shape is tier-dependent:
 *   - Pro / Demo: single batched request with comma-separated contract_addresses
 *   - Free public API: batching is REJECTED with HTTP 400 / error_code 10012
 *     ("allowed limit of 1 contract address"), so we issue one sequential
 *     request per address instead. This trades throughput for correctness.
 *
 * Retries up to 3 times on 5xx / network errors with linear backoff (600ms, 1200ms).
 * 4xx responses (including 401/403 bad-key and 429 rate-limit) exit immediately.
 * Returns a map of lowercase-address → price (null when not found).
 */
async function fetchCoinGeckoTokenPrices(
  network: "mainnet" | "sepolia",
  tokenAddresses: string[]
): Promise<Record<string, number | null>> {
  if (network !== "mainnet" || tokenAddresses.length === 0) return {};

  const unique = [...new Set(tokenAddresses.map((a) => a.toLowerCase()))];
  const env = typeof process !== "undefined" ? process.env : undefined;
  const proKey = env?.COINGECKO_PRO_API_KEY;
  const demoKey = env?.COINGECKO_DEMO_API_KEY ?? env?.COINGECKO_API_KEY;

  // Prefer Pro if both are set; otherwise Demo; otherwise free public API.
  const base = proKey ? COINGECKO_PRO_API_BASE : COINGECKO_API_BASE;
  const headers: Record<string, string> = { accept: "application/json" };
  if (proKey) headers["x-cg-pro-api-key"] = proKey;
  else if (demoKey) headers["x-cg-demo-api-key"] = demoKey;

  // CoinGecko's FREE public API enforces a 1-address-per-request limit (error
  // code 10012). Demo and Pro tiers accept comma-separated batches.
  //   - No key  → iterate one-at-a-time (sequential, to respect the strict
  //     10–30 req/min free-tier rate limit)
  //   - Demo / Pro → single batched request
  const isFreeTier = !proKey && !demoKey;
  const addressChunks = isFreeTier ? unique.map((a) => [a]) : [unique];

  const out: Record<string, number | null> = {};
  for (const address of unique) out[address] = null;

  for (const chunk of addressChunks) {
    const url =
      `${base}/simple/token_price/mantle` +
      `?contract_addresses=${chunk.join(",")}&vs_currencies=usd`;

    let payload: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      let retryable = false;
      try {
        const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
        if (response.ok) {
          payload = await response.json();
          break;
        }
        // 4xx (including 401/403/429) — not retryable; break out
        if (response.status >= 400 && response.status < 500) break;
        // 5xx — retryable
        retryable = true;
      } catch {
        // Network error or timeout — retryable
        retryable = true;
      } finally {
        clearTimeout(timer);
      }
      if (!retryable || attempt === 2) break;
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }

    const parsed = CoinGeckoResponseSchema.safeParse(payload);
    if (!parsed.success) continue;

    for (const address of chunk) {
      const entry = parsed.data[address];
      const price = asFiniteNumber(entry?.usd);
      if (price !== null && price > 0) out[address] = price;
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/*  Cross-source price validation                                       */
/* ------------------------------------------------------------------ */

/** Thresholds for inter-source price agreement. */
const PRICE_AGREE_PCT = 0.03;  // ≤3 %  → high confidence
const PRICE_WARN_PCT  = 0.15;  // ≤15 % → medium confidence; above → low

interface PriceRawSources {
  coingecko: number | null;
  dexscreener: number | null;
  defillama: number | null;
}

interface PriceValidation {
  price: number | null;
  source: "coingecko" | "dexscreener" | "defillama" | "aggregate" | "none";
  confidence: "high" | "medium" | "low";
  warnings: string[];
  price_sources: PriceRawSources;
}

/**
 * Select the best available price using CoinGecko as primary.
 * Cross-validates against DexScreener and DefiLlama; emits confidence and
 * warnings reflecting how well sources agree.
 */
function crossValidatePrices(
  coingecko: number | null,
  dexscreener: number | null,
  defillama: number | null
): PriceValidation {
  const price_sources: PriceRawSources = { coingecko, dexscreener, defillama };
  const fmt = (n: number) => `$${n.toPrecision(6)}`;
  const pct = (d: number) => `${(d * 100).toFixed(1)}%`;

  // ── CoinGecko is available ───────────────────────────────────────────────
  if (coingecko != null) {
    const secondaries = [
      { name: "DexScreener", value: dexscreener },
      { name: "DefiLlama",   value: defillama   }
    ].filter((s): s is { name: string; value: number } => s.value != null);

    if (secondaries.length === 0) {
      return {
        price: coingecko, source: "coingecko", confidence: "medium",
        warnings: ["CoinGecko price unverified — secondary sources returned no data."],
        price_sources
      };
    }

    const maxDev = Math.max(
      ...secondaries.map((s) => Math.abs(coingecko - s.value) / coingecko)
    );

    if (maxDev <= PRICE_AGREE_PCT) {
      return { price: coingecko, source: "coingecko", confidence: "high", warnings: [], price_sources };
    }

    if (maxDev <= PRICE_WARN_PCT) {
      const worst = secondaries.reduce((a, b) =>
        Math.abs(coingecko - a.value) >= Math.abs(coingecko - b.value) ? a : b
      );
      return {
        price: coingecko, source: "coingecko", confidence: "medium",
        warnings: [
          `Price sources diverge by ${pct(maxDev)} ` +
          `(CoinGecko ${fmt(coingecko)} vs ${worst.name} ${fmt(worst.value)}) — using CoinGecko as primary.`
        ],
        price_sources
      };
    }

    // > PRICE_WARN_PCT — significant divergence
    const details = secondaries
      .map((s) => `${s.name}: ${fmt(s.value)}`)
      .join(", ");
    return {
      price: coingecko, source: "coingecko", confidence: "low",
      warnings: [
        `Significant price divergence (${pct(maxDev)}): CoinGecko ${fmt(coingecko)}, ${details}. ` +
        `Using CoinGecko; verify the token's liquidity before acting.`
      ],
      price_sources
    };
  }

  // ── CoinGecko unavailable — fall back ────────────────────────────────────
  if (dexscreener != null && defillama != null) {
    const dev = Math.abs(dexscreener - defillama) / dexscreener;
    if (dev <= PRICE_AGREE_PCT) {
      return {
        price: dexscreener, source: "dexscreener", confidence: "medium",
        warnings: ["CoinGecko unavailable; DexScreener and DefiLlama agree."],
        price_sources
      };
    }
    // Weighted average (equal weight) as best estimate when two secondaries disagree
    const avg = (dexscreener + defillama) / 2;
    return {
      price: avg, source: "aggregate", confidence: "low",
      warnings: [
        `CoinGecko unavailable; DexScreener (${fmt(dexscreener)}) and DefiLlama (${fmt(defillama)}) ` +
        `diverge by ${pct(dev)} — using their average.`
      ],
      price_sources
    };
  }

  if (dexscreener != null) {
    return {
      price: dexscreener, source: "dexscreener", confidence: "low",
      warnings: ["CoinGecko unavailable; using DexScreener as sole source."],
      price_sources
    };
  }

  if (defillama != null) {
    return {
      price: defillama, source: "defillama", confidence: "low",
      warnings: ["CoinGecko unavailable; using DefiLlama as sole source."],
      price_sources
    };
  }

  return { price: null, source: "none", confidence: "low", warnings: [], price_sources };
}

type ConfidenceLevel = "high" | "medium" | "low";

/**
 * Returns the lower of two confidence levels. Used to compound uncertainty —
 * e.g., an MNT-denominated price inherits the weaker of (token USD confidence,
 * MNT USD confidence) so a low-confidence MNT quote can't launder a
 * high-confidence token quote.
 */
function lowerConfidence(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
  const rank: Record<ConfidenceLevel, number> = { low: 0, medium: 1, high: 2 };
  return rank[a] <= rank[b] ? a : b;
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

  // Fetch all three price sources in parallel for speed
  const [cgPrices, dexPricesArr, llamaPrices] = await Promise.all([
    fetchCoinGeckoTokenPrices(network, quotedAddresses),
    Promise.all(quotedAddresses.map((address) => fetchDexScreenerTokenPriceUsd(network, address))),
    fetchDefiLlamaTokenPrices(network, quotedAddresses)
  ]);

  // Build per-address lookup from the DexScreener parallel array
  const dexByAddress: Record<string, number | null> = {};
  for (let i = 0; i < quotedAddresses.length; i++) {
    dexByAddress[quotedAddresses[i]] = dexPricesArr[i];
  }

  // Cross-validate each address against all three sources
  const validationByAddress: Record<string, PriceValidation> = {};
  for (const address of quotedAddresses) {
    validationByAddress[address] = crossValidatePrices(
      cgPrices[address] ?? null,
      dexByAddress[address] ?? null,
      llamaPrices[address] ?? null
    );
  }

  const mntValidation = mntPricingAddress != null ? (validationByAddress[mntPricingAddress] ?? null) : null;
  const mntUsd = mntValidation?.price ?? null;

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
        price_sources: { coingecko: null, dexscreener: null, defillama: null },
        quoted_at_utc: quotedAt,
        warnings: [entry.parseError ?? "Token could not be resolved."]
      };
    }

    const symbol = entry.resolved.symbol;
    const address = entry.resolved.address;
    const validation = entry.pricingAddress ? (validationByAddress[entry.pricingAddress] ?? null) : null;
    const usdPrice = validation?.price ?? null;
    const source = validation?.source ?? "none";
    const priceSources = validation?.price_sources ?? { coingecko: null, dexscreener: null, defillama: null };
    const sourceWarnings = validation?.warnings ?? [];

    if (baseCurrency === "mnt") {
      if (address === "native" || symbol?.toLowerCase() === "mnt" || symbol?.toLowerCase() === "wmnt") {
        return {
          input: entry.input,
          symbol,
          address,
          price: 1,
          source: "derived" as const,
          confidence: "high" as const,
          price_sources: priceSources,
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
          price_sources: priceSources,
          quoted_at_utc: quotedAt,
          warnings: [...sourceWarnings, "MNT quote currency conversion unavailable."]
        };
      }
      return {
        input: entry.input,
        symbol,
        address,
        price: usdPrice / mntUsd,
        source,
        confidence: lowerConfidence(
          validation?.confidence ?? "low",
          mntValidation?.confidence ?? "low"
        ),
        price_sources: priceSources,
        quoted_at_utc: quotedAt,
        warnings: [
          ...sourceWarnings,
          ...((mntValidation?.warnings ?? []).map((w) => `MNT: ${w}`))
        ]
      };
    }

    return {
      input: entry.input,
      symbol,
      address,
      price: usdPrice,
      source,
      confidence: validation?.confidence ?? (usdPrice == null ? ("low" as const) : ("medium" as const)),
      price_sources: priceSources,
      quoted_at_utc: quotedAt,
      warnings: [
        ...sourceWarnings,
        ...(usdPrice == null ? ["No trusted valuation backend returned this token price."] : [])
      ]
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
