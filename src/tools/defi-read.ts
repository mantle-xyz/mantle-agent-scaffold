import { formatUnits, getAddress, isAddress, parseUnits } from "viem";
import { MANTLE_PROTOCOLS } from "../config/protocols.js";
import { MantleMcpError } from "../errors.js";
import { getPublicClient } from "../lib/clients.js";
import { normalizeNetwork } from "../lib/network.js";
import { resolveTokenInput as resolveTokenInputFromRegistry } from "../lib/token-registry.js";
import type { ResolvedTokenInput } from "../lib/token-registry.js";
import type { Tool } from "../types.js";

interface SwapQuoteDeps {
  resolveTokenInput: (
    token: string,
    network?: "mainnet" | "sepolia"
  ) => Promise<ResolvedTokenInput> | ResolvedTokenInput;
  quoteProvider: (params: {
    provider: "agni" | "merchant_moe" | "fluxion";
    tokenIn: ResolvedTokenInput;
    tokenOut: ResolvedTokenInput;
    amountInRaw: bigint;
    network: "mainnet" | "sepolia";
    feeTier: number | null;
  }) => Promise<{
    estimated_out_raw: string;
    estimated_out_decimal: string;
    price_impact_pct: number | null;
    route: string;
    fee_tier: number | null;
  } | null>;
  now: () => string;
}

interface SourceTraceEntry {
  source: string;
  tier: number;
  status: "success" | "empty" | "error" | "skipped";
  reason?: string;
}

interface ConfidenceScore {
  score: number;
  freshness: number;
  coverage: number;
  source_count: number;
  conflict_penalty: number;
}

interface TokenPriceLookup {
  prices: Record<string, number | null>;
  source_trace?: SourceTraceEntry[];
}

interface PoolLiquidityDeps {
  readPool: (params: {
    poolAddress: string;
    provider: "agni" | "merchant_moe" | "fluxion";
    network: "mainnet" | "sepolia";
  }) => Promise<{
    token_0: { address: string; symbol: string | null; decimals: number | null };
    token_1: { address: string; symbol: string | null; decimals: number | null };
    reserve_0_raw: string;
    reserve_1_raw: string;
    fee_tier: number | null;
    total_liquidity_usd?: number | null;
  } | null>;
  readPoolFromSubgraph: (params: {
    poolAddress: string;
    provider: "agni" | "merchant_moe" | "fluxion";
    network: "mainnet" | "sepolia";
  }) => Promise<{
    token_0: { address: string; symbol: string | null; decimals: number | null };
    token_1: { address: string; symbol: string | null; decimals: number | null };
    reserve_0_raw: string;
    reserve_1_raw: string;
    fee_tier: number | null;
    total_liquidity_usd?: number | null;
  } | null>;
  readPoolFromIndexer: (params: {
    poolAddress: string;
    provider: "agni" | "merchant_moe" | "fluxion";
    network: "mainnet" | "sepolia";
  }) => Promise<{
    token_0: { address: string; symbol: string | null; decimals: number | null };
    token_1: { address: string; symbol: string | null; decimals: number | null };
    reserve_0_raw: string;
    reserve_1_raw: string;
    fee_tier: number | null;
    total_liquidity_usd?: number | null;
  } | null>;
  getTokenPrices: (params: {
    network: "mainnet" | "sepolia";
    tokenAddresses: [string, string];
  }) => Promise<TokenPriceLookup | Record<string, number | null>>;
  now: () => string;
}

interface PoolOpportunitiesDeps {
  resolveTokenInput: (
    token: string,
    network?: "mainnet" | "sepolia"
  ) => Promise<ResolvedTokenInput> | ResolvedTokenInput;
  getTokenPairs: (
    network: "mainnet" | "sepolia",
    tokenAddress: string
  ) => Promise<DexScreenerPair[]>;
  now: () => string;
}

interface LendingMarketsDeps {
  marketProvider: (params: {
    protocol: "aave_v3";
    network: "mainnet" | "sepolia";
  }) => Promise<LendingMarket[]>;
  marketProviderFromSubgraph: (params: {
    protocol: "aave_v3";
    network: "mainnet" | "sepolia";
  }) => Promise<LendingMarket[]>;
  marketProviderFromIndexer: (params: {
    protocol: "aave_v3";
    network: "mainnet" | "sepolia";
  }) => Promise<LendingMarket[]>;
  now: () => string;
}

type ProtocolTvlKey = "agni" | "merchant_moe" | "fluxion";

type ProtocolTvlValue =
  | {
      tvl_usd: number;
      updated_at_unix?: number | null;
    }
  | number
  | null;

interface ProtocolTvlDeps {
  protocolTvlProvider: (params: {
    protocol: ProtocolTvlKey;
    network: "mainnet" | "sepolia";
  }) => Promise<ProtocolTvlValue>;
  protocolTvlFromSubgraph: (params: {
    protocol: ProtocolTvlKey;
    network: "mainnet" | "sepolia";
  }) => Promise<ProtocolTvlValue>;
  protocolTvlFromIndexer: (params: {
    protocol: ProtocolTvlKey;
    network: "mainnet" | "sepolia";
  }) => Promise<ProtocolTvlValue>;
  now: () => string;
}

interface LendingMarket {
  protocol: string;
  asset: string;
  asset_address: string;
  supply_apy: number;
  borrow_apy_variable: number;
  borrow_apy_stable: number | null;
  tvl_usd: number | null;
  ltv: number | null;
  liquidation_threshold: number | null;
}

interface DexScreenerPair {
  dexId?: string;
  pairAddress?: string;
  baseToken?: {
    address?: string;
    symbol?: string;
  };
  quoteToken?: {
    address?: string;
    symbol?: string;
  };
  priceNative?: string;
  priceUsd?: string;
  liquidity?: {
    usd?: number | string | null;
    base?: number | string | null;
    quote?: number | string | null;
  };
  volume?: {
    h24?: number | string | null;
  };
}

const DEXSCREENER_API_BASE = "https://api.dexscreener.com";
const DEFILLAMA_PRICES_API_BASE = "https://coins.llama.fi/prices/current";
const DEFILLAMA_PROTOCOL_API_BASE = "https://api.llama.fi/protocol";
const PRICE_SCALE_DECIMALS = 18;
const PRICE_SCALE = 10n ** BigInt(PRICE_SCALE_DECIMALS);

const PROTOCOL_TVL_SLUGS: Record<ProtocolTvlKey, string> = {
  agni: "agni-finance",
  merchant_moe: "merchant-moe",
  fluxion: "fluxion"
};

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

function providerToDexId(provider: "agni" | "merchant_moe" | "fluxion"): string {
  if (provider === "fluxion") return "0xf883162ed9c7e8ef604214c964c678e40c9b737c";
  return provider === "agni" ? "agni" : "merchantmoe";
}

function dexIdToProvider(dexId: string | undefined): "agni" | "merchant_moe" | "fluxion" | null {
  const normalized = (dexId ?? "").toLowerCase();
  if (normalized === "agni") {
    return "agni";
  }
  if (normalized === "merchantmoe") {
    return "merchant_moe";
  }
  if (normalized === "0xf883162ed9c7e8ef604214c964c678e40c9b737c") {
    return "fluxion";
  }
  return null;
}

function normalizeAddressLower(address: string): string {
  return getAddress(address).toLowerCase();
}

function addressesEqual(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right || !isAddress(left, { strict: false }) || !isAddress(right, { strict: false })) {
    return false;
  }
  return normalizeAddressLower(left) === normalizeAddressLower(right);
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

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function freshnessByTier(tier: number): number {
  if (tier <= 1) {
    return 1;
  }
  if (tier === 2) {
    return 0.85;
  }
  if (tier === 3) {
    return 0.7;
  }
  return 0.55;
}

function buildConfidence(params: {
  coverage: number;
  tierUsed: number;
  successfulSources: number;
  conflict: boolean;
}): ConfidenceScore {
  const coverage = clampScore(params.coverage);
  const freshness = freshnessByTier(params.tierUsed);
  const sourceCount = clampScore(params.successfulSources / 2);
  const conflictPenalty = params.conflict ? 0.2 : 0;
  const score = clampScore(
    coverage * 0.5 + freshness * 0.3 + sourceCount * 0.2 - conflictPenalty
  );

  return {
    score: roundScore(score),
    freshness: roundScore(freshness),
    coverage: roundScore(coverage),
    source_count: params.successfulSources,
    conflict_penalty: conflictPenalty
  };
}

function unpackTokenPriceLookup(
  payload: TokenPriceLookup | Record<string, number | null>
): TokenPriceLookup {
  if ("prices" in payload && payload.prices && typeof payload.prices === "object") {
    return payload as TokenPriceLookup;
  }
  return {
    prices: payload as Record<string, number | null>,
    source_trace: []
  };
}

function normalizeProtocolTvlValue(value: ProtocolTvlValue): {
  tvl_usd: number;
  updated_at_unix: number | null;
} | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? { tvl_usd: value, updated_at_unix: null } : null;
  }

  const tvl = asFiniteNumber(value.tvl_usd);
  if (tvl == null) {
    return null;
  }

  const updatedAtRaw = value.updated_at_unix;
  const updatedAt = asFiniteNumber(updatedAtRaw);
  return {
    tvl_usd: tvl,
    updated_at_unix: updatedAt == null ? null : Math.floor(updatedAt)
  };
}

function latestTvlPointFromSeries(series: unknown): { tvl_usd: number; updated_at_unix: number | null } | null {
  if (!Array.isArray(series)) {
    return null;
  }

  let latest: { tvl_usd: number; updated_at_unix: number | null } | null = null;
  for (const item of series) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const tvl = asFiniteNumber(record.totalLiquidityUSD);
    if (tvl == null) {
      continue;
    }

    const dateValue = asFiniteNumber(record.date);
    const normalized = {
      tvl_usd: tvl,
      updated_at_unix: dateValue == null ? null : Math.floor(dateValue)
    };

    if (!latest) {
      latest = normalized;
      continue;
    }
    if (
      normalized.updated_at_unix != null &&
      (latest.updated_at_unix == null || normalized.updated_at_unix > latest.updated_at_unix)
    ) {
      latest = normalized;
    }
  }

  return latest;
}

function extractLatestDefiLlamaProtocolTvl(
  payload: unknown,
  network: "mainnet" | "sepolia"
): { tvl_usd: number; updated_at_unix: number | null } | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (network !== "mainnet") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const chainTvls = record.chainTvls as Record<string, unknown> | undefined;

  const chainEntry =
    chainTvls && typeof chainTvls === "object"
      ? (chainTvls.Mantle as Record<string, unknown> | undefined)
      : undefined;
  const chainPoint =
    latestTvlPointFromSeries(chainEntry?.tvl) ??
    latestTvlPointFromSeries(chainEntry?.tokensInUsd) ??
    latestTvlPointFromSeries(chainEntry?.tokenPool2);
  if (chainPoint) {
    return chainPoint;
  }

  return latestTvlPointFromSeries(record.tvl);
}

async function fetchDefiLlamaProtocolTvl(
  protocol: ProtocolTvlKey,
  network: "mainnet" | "sepolia"
): Promise<{ tvl_usd: number; updated_at_unix: number | null } | null> {
  const slug = PROTOCOL_TVL_SLUGS[protocol];
  if (!slug) {
    return null;
  }

  const payload = await fetchJsonSafe(`${DEFILLAMA_PROTOCOL_API_BASE}/${slug}`);
  return extractLatestDefiLlamaProtocolTvl(payload, network);
}

function normalizeProtocolInput(input: string): "all" | ProtocolTvlKey {
  const normalized = input.trim().toLowerCase();
  if (normalized === "all") {
    return "all";
  }
  if (["agni", "agni-finance"].includes(normalized)) {
    return "agni";
  }
  if (["merchant_moe", "merchantmoe", "merchant-moe", "merchant-moe-dex"].includes(normalized)) {
    return "merchant_moe";
  }
  throw new MantleMcpError(
    "UNSUPPORTED_PROTOCOL",
    `Unsupported protocol for TVL: ${input}`,
    "Use protocol=agni, protocol=merchant_moe, or protocol=all.",
    { protocol: input }
  );
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

function parseDecimalToRaw(value: number | string | null | undefined, decimals: number | null): string {
  if (decimals == null || decimals < 0) {
    return "0";
  }
  if (value == null) {
    return "0";
  }
  const decimalInput = typeof value === "number" ? value.toString() : value;
  if (!decimalInput || Number.isNaN(Number(decimalInput))) {
    return "0";
  }
  try {
    return parseUnits(decimalInput, decimals).toString();
  } catch {
    return "0";
  }
}

async function fetchDexScreenerTokenPairs(
  network: "mainnet" | "sepolia",
  tokenAddress: string
): Promise<DexScreenerPair[]> {
  const chainId = resolveDexScreenerChain(network);
  if (!chainId) {
    return [];
  }
  const payload = await fetchJsonSafe(
    `${DEXSCREENER_API_BASE}/token-pairs/v1/${chainId}/${tokenAddress}`
  );
  return Array.isArray(payload) ? (payload as DexScreenerPair[]) : [];
}

async function fetchDexScreenerPairByAddress(
  network: "mainnet" | "sepolia",
  poolAddress: string
): Promise<DexScreenerPair | null> {
  const chainId = resolveDexScreenerChain(network);
  if (!chainId) {
    return null;
  }
  const payload = await fetchJsonSafe(
    `${DEXSCREENER_API_BASE}/latest/dex/pairs/${chainId}/${poolAddress}`
  );
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.pairs)) {
    return null;
  }
  const pairs = payload.pairs as DexScreenerPair[];
  return (
    pairs.find((pair) => addressesEqual(pair.pairAddress, poolAddress)) ??
    pairs[0] ??
    null
  );
}

function pickBestDexPairForRoute(
  pairs: DexScreenerPair[],
  provider: "agni" | "merchant_moe" | "fluxion",
  tokenInAddress: string,
  tokenOutAddress: string
): DexScreenerPair | null {
  const dexId = providerToDexId(provider);
  const candidates = pairs.filter((pair) => {
    if ((pair.dexId ?? "").toLowerCase() !== dexId) {
      return false;
    }
    const base = pair.baseToken?.address;
    const quote = pair.quoteToken?.address;
    return (
      (addressesEqual(base, tokenInAddress) && addressesEqual(quote, tokenOutAddress)) ||
      (addressesEqual(base, tokenOutAddress) && addressesEqual(quote, tokenInAddress))
    );
  });

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    const leftLiq = asFiniteNumber(left.liquidity?.usd) ?? 0;
    const rightLiq = asFiniteNumber(right.liquidity?.usd) ?? 0;
    return rightLiq - leftLiq;
  });

  return candidates[0];
}

function estimateSwapOutRawFromDexPair(params: {
  pair: DexScreenerPair;
  tokenIn: ResolvedTokenInput;
  tokenOut: ResolvedTokenInput;
  amountInRaw: bigint;
}): bigint | null {
  const { pair, tokenIn, tokenOut, amountInRaw } = params;
  if (tokenIn.decimals == null || tokenOut.decimals == null) {
    return null;
  }

  const priceNative = pair.priceNative ?? "";
  if (!priceNative) {
    return null;
  }

  let priceScaled: bigint;
  try {
    priceScaled = parseUnits(priceNative, PRICE_SCALE_DECIMALS);
  } catch {
    return null;
  }

  if (priceScaled <= 0n) {
    return null;
  }

  const inUnit = 10n ** BigInt(tokenIn.decimals);
  const outUnit = 10n ** BigInt(tokenOut.decimals);
  const base = pair.baseToken?.address ?? null;
  const quote = pair.quoteToken?.address ?? null;

  if (addressesEqual(base, tokenIn.address) && addressesEqual(quote, tokenOut.address)) {
    return (amountInRaw * priceScaled * outUnit) / (PRICE_SCALE * inUnit);
  }

  if (addressesEqual(base, tokenOut.address) && addressesEqual(quote, tokenIn.address)) {
    return (amountInRaw * PRICE_SCALE * outUnit) / (priceScaled * inUnit);
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
  if (!Array.isArray(payload) || payload.length === 0) {
    return null;
  }

  const pairs = payload as DexScreenerPair[];
  const best =
    pairs.find((pair) => addressesEqual(pair.baseToken?.address, tokenAddress)) ??
    pairs[0];
  return asFiniteNumber(best?.priceUsd);
}

async function fetchDefiLlamaTokenPrices(
  network: "mainnet" | "sepolia",
  tokenAddresses: string[]
): Promise<Record<string, number | null>> {
  const chainId = resolveDefiLlamaChain(network);
  if (!chainId || tokenAddresses.length === 0) {
    return {};
  }

  const normalized = [...new Set(tokenAddresses.map((address) => normalizeAddressLower(address)))];
  const coinsParam = normalized.map((address) => `${chainId}:${address}`).join(",");
  const payload = await fetchJsonSafe(`${DEFILLAMA_PRICES_API_BASE}/${coinsParam}`);
  const coins =
    payload && typeof payload === "object" && payload.coins && typeof payload.coins === "object"
      ? (payload.coins as Record<string, { price?: number }>)
      : {};

  const out: Record<string, number | null> = {};
  for (const address of normalized) {
    const key = `${chainId}:${address}`;
    out[address] = asFiniteNumber(coins[key]?.price);
  }
  return out;
}

const defaultSwapDeps: SwapQuoteDeps = {
  resolveTokenInput: (token, network) => resolveTokenInputFromRegistry(token, network ?? "mainnet"),
  quoteProvider: async ({ provider, tokenIn, tokenOut, amountInRaw, network, feeTier }) => {
    const pairs = await fetchDexScreenerTokenPairs(network, tokenIn.address);
    const pair = pickBestDexPairForRoute(
      pairs,
      provider,
      tokenIn.address,
      tokenOut.address
    );
    if (!pair) {
      return null;
    }

    const estimatedOutRaw = estimateSwapOutRawFromDexPair({
      pair,
      tokenIn,
      tokenOut,
      amountInRaw
    });
    if (estimatedOutRaw == null || estimatedOutRaw <= 0n) {
      return null;
    }

    return {
      estimated_out_raw: estimatedOutRaw.toString(),
      estimated_out_decimal: formatUnits(estimatedOutRaw, tokenOut.decimals ?? 18),
      price_impact_pct: null,
      route: `dexscreener:${pair.dexId ?? "unknown"}:${pair.pairAddress ?? "unknown"}`,
      fee_tier: feeTier
    };
  },
  now: () => new Date().toISOString()
};

const defaultPoolDeps: PoolLiquidityDeps = {
  readPool: async ({ poolAddress, provider, network }) => {
    const pair = await fetchDexScreenerPairByAddress(network, poolAddress);
    if (!pair || (pair.dexId ?? "").toLowerCase() !== providerToDexId(provider)) {
      return null;
    }

    const token0Address = pair.baseToken?.address ?? "";
    const token1Address = pair.quoteToken?.address ?? "";
    if (
      !isAddress(token0Address, { strict: false }) ||
      !isAddress(token1Address, { strict: false })
    ) {
      return null;
    }

    const token0 = await resolveTokenInputFromRegistry(token0Address, network);
    const token1 = await resolveTokenInputFromRegistry(token1Address, network);

    return {
      token_0: {
        address: getAddress(token0Address),
        symbol: token0.symbol ?? pair.baseToken?.symbol ?? null,
        decimals: token0.decimals
      },
      token_1: {
        address: getAddress(token1Address),
        symbol: token1.symbol ?? pair.quoteToken?.symbol ?? null,
        decimals: token1.decimals
      },
      reserve_0_raw: parseDecimalToRaw(pair.liquidity?.base, token0.decimals),
      reserve_1_raw: parseDecimalToRaw(pair.liquidity?.quote, token1.decimals),
      fee_tier: null,
      total_liquidity_usd: asFiniteNumber(pair.liquidity?.usd)
    };
  },
  readPoolFromSubgraph: async () => null,
  readPoolFromIndexer: async () => null,
  getTokenPrices: async ({ network, tokenAddresses }) => {
    const normalized = [...new Set(tokenAddresses.map((address) => normalizeAddressLower(address)))];
    const out: Record<string, number | null> = {};
    const sourceTrace: SourceTraceEntry[] = [];

    const dexPrices = await Promise.all(
      normalized.map((address) => fetchDexScreenerTokenPriceUsd(network, address))
    );
    const missing: string[] = [];

    for (let i = 0; i < normalized.length; i += 1) {
      const address = normalized[i];
      const price = dexPrices[i];
      if (typeof price === "number") {
        out[address] = price;
      } else {
        missing.push(address);
      }
    }

    sourceTrace.push({
      source: "dexscreener",
      tier: 1,
      status: missing.length === normalized.length ? "empty" : "success",
      reason:
        missing.length === normalized.length
          ? "dexscreener token prices unavailable"
          : undefined
    });

    if (missing.length > 0) {
      const fallbackPrices = await fetchDefiLlamaTokenPrices(network, missing);
      for (const address of missing) {
        out[address] = fallbackPrices[address] ?? null;
      }

      const resolvedCount = missing.filter((address) => typeof fallbackPrices[address] === "number").length;
      sourceTrace.push({
        source: "defillama",
        tier: 2,
        status: resolvedCount > 0 ? "success" : "empty",
        reason: resolvedCount > 0 ? undefined : "defillama token prices unavailable"
      });
    }

    return {
      prices: out,
      source_trace: sourceTrace
    };
  },
  now: () => new Date().toISOString()
};

const defaultPoolOpportunityDeps: PoolOpportunitiesDeps = {
  resolveTokenInput: (token, network) => resolveTokenInputFromRegistry(token, network ?? "mainnet"),
  getTokenPairs: fetchDexScreenerTokenPairs,
  now: () => new Date().toISOString()
};

const AAVE_PROTOCOL_DATA_PROVIDER_ABI = [
  {
    type: "function",
    name: "getAllReservesTokens",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "symbol", type: "string" },
          { name: "tokenAddress", type: "address" }
        ]
      }
    ]
  },
  {
    type: "function",
    name: "getReserveData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint40" }
    ]
  },
  {
    type: "function",
    name: "getReserveConfigurationData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bool" },
      { type: "bool" },
      { type: "bool" },
      { type: "bool" },
      { type: "bool" }
    ]
  }
] as const;

const AAVE_POOL_ADDRESSES_PROVIDER_ABI = [
  {
    type: "function",
    name: "getPriceOracle",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }]
  }
] as const;

const AAVE_ORACLE_ABI = [
  {
    type: "function",
    name: "BASE_CURRENCY",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }]
  },
  {
    type: "function",
    name: "BASE_CURRENCY_UNIT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }]
  },
  {
    type: "function",
    name: "getAssetPrice",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "uint256" }]
  }
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const RAY = 10n ** 27n;

function rayToPercent(value: bigint): number {
  return Number((value * 10000n) / RAY) / 100;
}

function bpsToPercent(value: bigint): number {
  return Number(value) / 100;
}

function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(value);
  }
  return BigInt(String(value));
}

function toUsdValue(
  supplyRaw: bigint,
  decimals: number,
  assetPriceInBase: bigint,
  baseCurrencyUnit: bigint
): number | null {
  if (decimals < 0 || assetPriceInBase <= 0n || baseCurrencyUnit <= 0n) {
    return null;
  }

  const tokenUnit = 10n ** BigInt(decimals);
  const supplyInBase = (supplyRaw * assetPriceInBase) / tokenUnit;
  const dollars = Number(supplyInBase) / Number(baseCurrencyUnit);
  return Number.isFinite(dollars) ? dollars : null;
}

async function loadAaveV3Markets(network: "mainnet" | "sepolia"): Promise<LendingMarket[]> {
  if (network !== "mainnet") {
    return [];
  }

  const protocol = MANTLE_PROTOCOLS[network].aave_v3;
  if (!protocol || protocol.status !== "enabled") {
    return [];
  }

  const poolAddressesProviderInput = protocol.contracts.pool_addresses_provider;
  const dataProviderInput = protocol.contracts.pool_data_provider;
  if (
    !poolAddressesProviderInput ||
    !dataProviderInput ||
    !isAddress(poolAddressesProviderInput, { strict: false }) ||
    !isAddress(dataProviderInput, { strict: false })
  ) {
    throw new MantleMcpError(
      "LENDING_DATA_UNAVAILABLE",
      "Aave V3 provider addresses are missing or invalid.",
      "Verify Mantle protocol registry for aave_v3 contract addresses.",
      { network, protocol: "aave_v3" }
    );
  }

  const poolAddressesProvider = getAddress(poolAddressesProviderInput);
  const dataProvider = getAddress(dataProviderInput);
  const client = getPublicClient(network);

  const reserves = (await client.readContract({
    address: dataProvider,
    abi: AAVE_PROTOCOL_DATA_PROVIDER_ABI,
    functionName: "getAllReservesTokens"
  })) as Array<{ symbol: string; tokenAddress: string }>;

  const oracleAddress = (await client.readContract({
    address: poolAddressesProvider,
    abi: AAVE_POOL_ADDRESSES_PROVIDER_ABI,
    functionName: "getPriceOracle"
  })) as string;

  if (!isAddress(oracleAddress, { strict: false })) {
    throw new MantleMcpError(
      "LENDING_DATA_UNAVAILABLE",
      "Aave oracle address is invalid.",
      "Retry later or verify pool addresses provider configuration.",
      { network, protocol: "aave_v3", oracle_address: oracleAddress }
    );
  }

  const oracle = getAddress(oracleAddress);
  const [baseCurrency, baseCurrencyUnit] = (await Promise.all([
    client.readContract({
      address: oracle,
      abi: AAVE_ORACLE_ABI,
      functionName: "BASE_CURRENCY"
    }),
    client.readContract({
      address: oracle,
      abi: AAVE_ORACLE_ABI,
      functionName: "BASE_CURRENCY_UNIT"
    })
  ])) as [string, bigint];

  const isUsdBaseCurrency = baseCurrency.toLowerCase() === ZERO_ADDRESS;

  const markets = await Promise.all(
    reserves.map(async (reserve): Promise<LendingMarket | null> => {
      const assetAddress = getAddress(reserve.tokenAddress);
      const [reserveData, reserveConfig, assetPrice] = (await Promise.all([
        client.readContract({
          address: dataProvider,
          abi: AAVE_PROTOCOL_DATA_PROVIDER_ABI,
          functionName: "getReserveData",
          args: [assetAddress]
        }),
        client.readContract({
          address: dataProvider,
          abi: AAVE_PROTOCOL_DATA_PROVIDER_ABI,
          functionName: "getReserveConfigurationData",
          args: [assetAddress]
        }),
        client.readContract({
          address: oracle,
          abi: AAVE_ORACLE_ABI,
          functionName: "getAssetPrice",
          args: [assetAddress]
        })
      ])) as [readonly unknown[], readonly unknown[], bigint];

      const isActive = Boolean(reserveConfig[8]);
      if (!isActive) {
        return null;
      }

      const decimals = Number(asBigInt(reserveConfig[0]));
      const ltv = bpsToPercent(asBigInt(reserveConfig[1]));
      const liquidationThreshold = bpsToPercent(asBigInt(reserveConfig[2]));
      const stableBorrowRateEnabled = Boolean(reserveConfig[7]);

      const totalAToken = asBigInt(reserveData[2]);
      const liquidityRate = asBigInt(reserveData[5]);
      const variableBorrowRate = asBigInt(reserveData[6]);
      const stableBorrowRate = asBigInt(reserveData[7]);

      const tvlUsd = isUsdBaseCurrency
        ? toUsdValue(totalAToken, decimals, assetPrice, baseCurrencyUnit)
        : null;

      return {
        protocol: "aave_v3",
        asset: reserve.symbol,
        asset_address: assetAddress,
        supply_apy: rayToPercent(liquidityRate),
        borrow_apy_variable: rayToPercent(variableBorrowRate),
        borrow_apy_stable: stableBorrowRateEnabled ? rayToPercent(stableBorrowRate) : null,
        tvl_usd: tvlUsd,
        ltv,
        liquidation_threshold: liquidationThreshold
      };
    })
  );

  return markets.filter((item): item is LendingMarket => item !== null);
}

const defaultLendingDeps: LendingMarketsDeps = {
  marketProvider: async ({ protocol, network }) => {
    if (protocol !== "aave_v3") {
      return [];
    }

    try {
      return await loadAaveV3Markets(network);
    } catch (error) {
      if (error instanceof MantleMcpError) {
        throw error;
      }

      throw new MantleMcpError(
        "LENDING_DATA_UNAVAILABLE",
        error instanceof Error ? error.message : String(error),
        "Check RPC health and Aave provider/oracle reachability, then retry.",
        { network, protocol: "aave_v3", retryable: true }
      );
    }
  },
  marketProviderFromSubgraph: async () => [],
  marketProviderFromIndexer: async () => [],
  now: () => new Date().toISOString()
};

const defaultProtocolTvlDeps: ProtocolTvlDeps = {
  protocolTvlProvider: async ({ protocol, network }) => fetchDefiLlamaProtocolTvl(protocol, network),
  protocolTvlFromSubgraph: async () => null,
  protocolTvlFromIndexer: async () => null,
  now: () => new Date().toISOString()
};

type SwapProviderQuote = NonNullable<Awaited<ReturnType<SwapQuoteDeps["quoteProvider"]>>>;

function withSwapDeps(overrides?: Partial<SwapQuoteDeps>): SwapQuoteDeps {
  return { ...defaultSwapDeps, ...overrides };
}

function withPoolDeps(overrides?: Partial<PoolLiquidityDeps>): PoolLiquidityDeps {
  return { ...defaultPoolDeps, ...overrides };
}

function withPoolOpportunityDeps(overrides?: Partial<PoolOpportunitiesDeps>): PoolOpportunitiesDeps {
  return { ...defaultPoolOpportunityDeps, ...overrides };
}

function withLendingDeps(overrides?: Partial<LendingMarketsDeps>): LendingMarketsDeps {
  return { ...defaultLendingDeps, ...overrides };
}

function withProtocolTvlDeps(overrides?: Partial<ProtocolTvlDeps>): ProtocolTvlDeps {
  return { ...defaultProtocolTvlDeps, ...overrides };
}

function resolveRouterAddress(
  provider: "agni" | "merchant_moe" | "fluxion",
  network: "mainnet" | "sepolia"
): string {
  const entry = MANTLE_PROTOCOLS[network][provider];
  if (!entry || entry.status !== "enabled") {
    throw new MantleMcpError(
      "UNSUPPORTED_PROTOCOL",
      `${provider} is not enabled on ${network}.`,
      "Use an enabled protocol or switch network.",
      { provider, network }
    );
  }

  const router =
    provider === "merchant_moe"
      ? entry.contracts.lb_router_v2_2
      : entry.contracts.swap_router; // agni and fluxion both use swap_router

  if (!router || !isAddress(router, { strict: false })) {
    throw new MantleMcpError(
      "UNSUPPORTED_PROTOCOL",
      `${provider} router is not configured for ${network}.`,
      "Check protocol registry configuration.",
      { provider, network }
    );
  }

  return getAddress(router);
}

function parseRawAmount(value: string, field: string, details: Record<string, unknown>): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `${field} must be a base-10 integer string.`,
      "Check upstream data source and retry.",
      details
    );
  }
}

export async function getSwapQuote(
  args: Record<string, unknown>,
  deps?: Partial<SwapQuoteDeps>
): Promise<any> {
  const resolvedDeps = withSwapDeps(deps);
  const { network } = normalizeNetwork(args);
  const tokenInInput = typeof args.token_in === "string" ? args.token_in : "";
  const tokenOutInput = typeof args.token_out === "string" ? args.token_out : "";
  const amountInInput = typeof args.amount_in === "string" ? args.amount_in : "";
  const providerInput =
    typeof args.provider === "string" ? args.provider : "best";
  const feeTier = typeof args.fee_tier === "number" ? args.fee_tier : null;

  if (!tokenInInput || !tokenOutInput || !amountInInput) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      "token_in, token_out, and amount_in are required.",
      "Provide token_in, token_out, and amount_in values.",
      { token_in: tokenInInput || null, token_out: tokenOutInput || null, amount_in: amountInInput || null }
    );
  }

  let providerSelection: "agni" | "merchant_moe" | "fluxion" | "best";
  if (providerInput === "agni" || providerInput === "merchant_moe" || providerInput === "fluxion" || providerInput === "best") {
    providerSelection = providerInput;
  } else {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `Unsupported provider: ${providerInput}`,
      "Use provider=agni, provider=fluxion, provider=merchant_moe, or provider=best.",
      { provider: providerInput }
    );
  }

  const tokenIn = await resolvedDeps.resolveTokenInput(tokenInInput, network);
  const tokenOut = await resolvedDeps.resolveTokenInput(tokenOutInput, network);

  if (tokenIn.decimals == null || tokenOut.decimals == null || tokenIn.address === "native" || tokenOut.address === "native") {
    throw new MantleMcpError(
      "TOKEN_NOT_FOUND",
      "Swap quote requires ERC-20 tokens with known decimals.",
      "Use ERC-20 token symbols/addresses available in mantle://registry/tokens.",
      { token_in: tokenInInput, token_out: tokenOutInput }
    );
  }

  if (tokenIn.address.toLowerCase() === tokenOut.address.toLowerCase()) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      "token_in and token_out must be different.",
      "Choose two different ERC-20 tokens for swap quote.",
      {
        token_in: tokenIn.address,
        token_out: tokenOut.address
      }
    );
  }

  let amountInRaw: bigint;
  try {
    amountInRaw = parseUnits(amountInInput, tokenIn.decimals);
  } catch {
    throw new MantleMcpError(
      "INVALID_INPUT",
      "amount_in is not a valid decimal amount.",
      "Provide a positive decimal amount_in with token precision.",
      { amount_in: amountInInput, token_decimals: tokenIn.decimals }
    );
  }

  if (amountInRaw <= 0n) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      "amount_in must be greater than zero.",
      "Provide a positive decimal amount_in.",
      { amount_in: amountInInput }
    );
  }

  const warnings: string[] = [];
  const sourceTrace: SourceTraceEntry[] = [];
  let selectedProvider: "agni" | "merchant_moe" | "fluxion";
  let quote: SwapProviderQuote | null = null;
  let successfulSources = 0;
  let tierUsed = 1;
  let hasConflict = false;
  let selectedOutRaw: bigint | null = null;

  if (providerSelection === "best") {
    const [agniResult, merchantMoeResult, fluxionResult] = await Promise.allSettled([
      resolvedDeps.quoteProvider({
        provider: "agni",
        tokenIn,
        tokenOut,
        amountInRaw,
        network,
        feeTier
      }),
      resolvedDeps.quoteProvider({
        provider: "merchant_moe",
        tokenIn,
        tokenOut,
        amountInRaw,
        network,
        feeTier
      }),
      resolvedDeps.quoteProvider({
        provider: "fluxion",
        tokenIn,
        tokenOut,
        amountInRaw,
        network,
        feeTier
      })
    ]);

    const candidates: Array<{
      provider: "agni" | "merchant_moe" | "fluxion";
      quote: SwapProviderQuote;
      outRaw: bigint;
    }> = [];

    for (const [label, result] of [
      ["agni", agniResult],
      ["merchant_moe", merchantMoeResult],
      ["fluxion", fluxionResult]
    ] as const) {
      if (result.status === "fulfilled" && result.value) {
        sourceTrace.push({
          source: `dexscreener:${label}`,
          tier: 1,
          status: "success"
        });
        candidates.push({
          provider: label,
          quote: result.value,
          outRaw: parseRawAmount(result.value.estimated_out_raw, "estimated_out_raw", {
            provider: label,
            token_in: tokenIn.address,
            token_out: tokenOut.address
          })
        });
      } else if (result.status === "fulfilled") {
        sourceTrace.push({
          source: `dexscreener:${label}`,
          tier: 1,
          status: "empty",
          reason: "no route"
        });
      } else {
        sourceTrace.push({
          source: `dexscreener:${label}`,
          tier: 1,
          status: "error",
          reason: result.reason instanceof Error ? result.reason.message : "quote provider failed"
        });
      }
    }

    if (candidates.length === 0) {
      throw new MantleMcpError(
        "NO_ROUTE",
        `No route found for ${tokenIn.symbol} -> ${tokenOut.symbol}.`,
        "Try another provider or pair.",
        {
          token_in: tokenIn.address,
          token_out: tokenOut.address,
          provider: "best",
          network
        }
      );
    }

    candidates.sort((a, b) => (a.outRaw === b.outRaw ? 0 : a.outRaw > b.outRaw ? -1 : 1));
    selectedProvider = candidates[0].provider;
    quote = candidates[0].quote;
    selectedOutRaw = candidates[0].outRaw;
    successfulSources = candidates.length;

    if (candidates.length === 1) {
      warnings.push("Best-route fallback used a single provider because the other had no quote.");
    } else {
      const best = candidates[0].outRaw;
      const second = candidates[1].outRaw;
      const spreadPct = Number(((best - second) * 10000n) / best) / 100;
      if (spreadPct > 20) {
        hasConflict = true;
        warnings.push("Provider quote conflict detected (>20% spread).");
      }
    }
  } else {
    selectedProvider = providerSelection;
    quote = await resolvedDeps.quoteProvider({
      provider: selectedProvider,
      tokenIn,
      tokenOut,
      amountInRaw,
      network,
      feeTier
    });

    if (!quote) {
      sourceTrace.push({
        source: `dexscreener:${selectedProvider}`,
        tier: 1,
        status: "empty",
        reason: "no route"
      });
      throw new MantleMcpError(
        "NO_ROUTE",
        `No route found for ${tokenIn.symbol} -> ${tokenOut.symbol}.`,
        "Try another provider or pair.",
        {
          token_in: tokenIn.address,
          token_out: tokenOut.address,
          provider: selectedProvider,
          network
        }
      );
    }

    sourceTrace.push({
      source: `dexscreener:${selectedProvider}`,
      tier: 1,
      status: "success"
    });
    successfulSources = 1;
  }

  const routerAddress = resolveRouterAddress(selectedProvider, network);
  const estimatedOutRaw = selectedOutRaw ?? parseRawAmount(quote.estimated_out_raw, "estimated_out_raw", {
    provider: selectedProvider,
    token_in: tokenIn.address,
    token_out: tokenOut.address
  });
  const minimumOutRaw = (estimatedOutRaw * 9950n) / 10000n;

  if (quote.price_impact_pct != null && quote.price_impact_pct > 1) {
    warnings.push("High price impact.");
  }

  const coverage =
    [
      quote.estimated_out_raw,
      quote.estimated_out_decimal,
      quote.route
    ].filter((value) => typeof value === "string" && value.length > 0).length / 3;
  const confidence = buildConfidence({
    coverage,
    tierUsed,
    successfulSources,
    conflict: hasConflict
  });

  return {
    intent: "pool_quote",
    provider: selectedProvider,
    token_in: {
      address: tokenIn.address,
      symbol: tokenIn.symbol,
      decimals: tokenIn.decimals
    },
    token_out: {
      address: tokenOut.address,
      symbol: tokenOut.symbol,
      decimals: tokenOut.decimals
    },
    amount_in_raw: amountInRaw.toString(),
    amount_in_decimal: amountInInput,
    estimated_out_raw: estimatedOutRaw.toString(),
    estimated_out_decimal: quote.estimated_out_decimal,
    minimum_out_raw: minimumOutRaw.toString(),
    minimum_out_decimal: formatUnits(minimumOutRaw, tokenOut.decimals),
    price_impact_pct: quote.price_impact_pct,
    route: quote.route,
    router_address: routerAddress,
    fee_tier: quote.fee_tier,
    quoted_at_utc: resolvedDeps.now(),
    source_trace: sourceTrace,
    confidence,
    warnings
  };
}

function deriveLiquidityUsdFromReserves(
  reserve0Raw: bigint,
  reserve1Raw: bigint,
  decimals0: number,
  decimals1: number,
  price0Usd: number,
  price1Usd: number
): number {
  const reserve0 = Number(formatUnits(reserve0Raw, decimals0));
  const reserve1 = Number(formatUnits(reserve1Raw, decimals1));
  return reserve0 * price0Usd + reserve1 * price1Usd;
}

export async function getPoolOpportunities(
  args: Record<string, unknown>,
  deps?: Partial<PoolOpportunitiesDeps>
): Promise<any> {
  const resolvedDeps = withPoolOpportunityDeps(deps);
  const { network } = normalizeNetwork(args);
  const tokenAInput = typeof args.token_a === "string" ? args.token_a : "";
  const tokenBInput = typeof args.token_b === "string" ? args.token_b : "";
  const providerInput = typeof args.provider === "string" ? args.provider : "all";
  const maxResultsInput = typeof args.max_results === "number" ? args.max_results : 5;
  const maxResults = Math.max(1, Math.min(10, Math.floor(maxResultsInput)));

  if (!tokenAInput || !tokenBInput) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      "token_a and token_b are required.",
      "Provide token_a and token_b as symbols or token addresses.",
      { token_a: tokenAInput || null, token_b: tokenBInput || null }
    );
  }

  const providerSelection: "agni" | "merchant_moe" | "fluxion" | "all" =
    providerInput === "agni" || providerInput === "merchant_moe" || providerInput === "fluxion" || providerInput === "all"
      ? providerInput
      : "all";

  const tokenA = await resolvedDeps.resolveTokenInput(tokenAInput, network);
  const tokenB = await resolvedDeps.resolveTokenInput(tokenBInput, network);

  const normalizeForDex = async (token: ResolvedTokenInput): Promise<string> => {
    if (token.address === "native") {
      const wrapped = await resolvedDeps.resolveTokenInput("WMNT", network);
      if (wrapped.address === "native") {
        throw new MantleMcpError(
          "TOKEN_NOT_FOUND",
          "WMNT is required for native MNT pool discovery.",
          "Ensure WMNT is available in mantle://registry/tokens.",
          { network }
        );
      }
      return wrapped.address;
    }
    return token.address;
  };

  const tokenAAddress = await normalizeForDex(tokenA);
  const tokenBAddress = await normalizeForDex(tokenB);

  if (addressesEqual(tokenAAddress, tokenBAddress)) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      "token_a and token_b must be different tokens.",
      "Select two distinct tokens for pool discovery.",
      { token_a: tokenAInput, token_b: tokenBInput }
    );
  }

  const pairs = await resolvedDeps.getTokenPairs(network, tokenAAddress);
  const sourceTrace: SourceTraceEntry[] = [];

  const candidates = pairs
    .filter((pair) => {
      const provider = dexIdToProvider(pair.dexId);
      if (!provider) {
        return false;
      }
      if (providerSelection !== "all" && provider !== providerSelection) {
        return false;
      }

      const base = pair.baseToken?.address ?? null;
      const quote = pair.quoteToken?.address ?? null;
      return (
        (addressesEqual(base, tokenAAddress) && addressesEqual(quote, tokenBAddress)) ||
        (addressesEqual(base, tokenBAddress) && addressesEqual(quote, tokenAAddress))
      );
    })
    .map((pair) => {
      const provider = dexIdToProvider(pair.dexId) as "agni" | "merchant_moe" | "fluxion";
      const poolAddress =
        pair.pairAddress && isAddress(pair.pairAddress, { strict: false })
          ? getAddress(pair.pairAddress)
          : null;
      const liquidityUsd = asFiniteNumber(pair.liquidity?.usd);
      const volume24h = asFiniteNumber(pair.volume?.h24);
      return {
        provider,
        pool_address: poolAddress,
        dex_id: pair.dexId ?? "unknown",
        liquidity_usd: liquidityUsd,
        volume_24h_usd: volume24h
      };
    })
    .filter((item) => item.pool_address !== null);

  if (candidates.length > 0) {
    sourceTrace.push({
      source: "dexscreener",
      tier: 1,
      status: "success"
    });
  } else {
    sourceTrace.push({
      source: "dexscreener",
      tier: 1,
      status: "empty",
      reason: "no matching pools found for token pair"
    });
    throw new MantleMcpError(
      "NO_ROUTE",
      "No matching liquidity pool candidates found.",
      "Try a different token pair or provider filter.",
      {
        token_a: tokenAAddress,
        token_b: tokenBAddress,
        provider: providerSelection,
        network
      }
    );
  }

  const maxLiquidity = Math.max(...candidates.map((item) => item.liquidity_usd ?? 0), 0);
  const maxVolume = Math.max(...candidates.map((item) => item.volume_24h_usd ?? 0), 0);

  const ranked = candidates
    .map((item) => {
      const liquidityScore =
        maxLiquidity > 0 && item.liquidity_usd != null ? item.liquidity_usd / maxLiquidity : 0;
      const volumeScore =
        maxVolume > 0 && item.volume_24h_usd != null ? item.volume_24h_usd / maxVolume : 0;
      const score = Number((liquidityScore * 0.7 + volumeScore * 0.3).toFixed(4));
      return {
        ...item,
        score
      };
    })
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      const liqLeft = left.liquidity_usd ?? 0;
      const liqRight = right.liquidity_usd ?? 0;
      return liqRight - liqLeft;
    })
    .slice(0, maxResults);

  const coverage =
    ranked.length === 0
      ? 0
      : ranked
          .map((item) => (item.liquidity_usd != null ? 1 : 0) + (item.volume_24h_usd != null ? 1 : 0))
          .reduce((sum, value) => sum + value, 0) /
        (ranked.length * 2);
  const confidence = buildConfidence({
    coverage,
    tierUsed: 1,
    successfulSources: 1,
    conflict: false
  });

  return {
    intent: "pool_opportunity_scan",
    token_a: {
      input: tokenAInput,
      symbol: tokenA.symbol,
      address: tokenA.address
    },
    token_b: {
      input: tokenBInput,
      symbol: tokenB.symbol,
      address: tokenB.address
    },
    provider: providerSelection,
    candidates: ranked,
    scanned_at_utc: resolvedDeps.now(),
    source_trace: sourceTrace,
    confidence,
    warnings: []
  };
}

export async function getPoolLiquidity(
  args: Record<string, unknown>,
  deps?: Partial<PoolLiquidityDeps>
): Promise<any> {
  const resolvedDeps = withPoolDeps(deps);
  const { network } = normalizeNetwork(args);
  const poolAddressInput = typeof args.pool_address === "string" ? args.pool_address : "";
  const providerInput = typeof args.provider === "string" ? args.provider : "agni";
  const provider: "agni" | "merchant_moe" | "fluxion" =
    providerInput === "merchant_moe" ? "merchant_moe" : providerInput === "fluxion" ? "fluxion" : "agni";

  if (!poolAddressInput || !isAddress(poolAddressInput, { strict: false })) {
    throw new MantleMcpError(
      "INVALID_ADDRESS",
      "pool_address must be a valid address.",
      "Provide a checksummed pool address.",
      { pool_address: poolAddressInput || null }
    );
  }

  const poolAddress = getAddress(poolAddressInput);
  const sourceTrace: SourceTraceEntry[] = [];
  let tierUsed = 1;
  let data = await resolvedDeps.readPool({
    poolAddress,
    provider,
    network
  });
  if (data) {
    sourceTrace.push({
      source: "dexscreener",
      tier: 1,
      status: "success"
    });
  } else {
    sourceTrace.push({
      source: "dexscreener",
      tier: 1,
      status: "empty",
      reason: "pool not found or provider mismatch"
    });
  }

  if (!data) {
    const subgraphData = await resolvedDeps.readPoolFromSubgraph({
      poolAddress,
      provider,
      network
    });
    if (subgraphData) {
      data = subgraphData;
      tierUsed = 2;
      sourceTrace.push({
        source: "subgraph",
        tier: 2,
        status: "success"
      });
    } else {
      sourceTrace.push({
        source: "subgraph",
        tier: 2,
        status: "empty",
        reason: "no compatible pool record"
      });
    }
  }

  if (!data) {
    const indexerData = await resolvedDeps.readPoolFromIndexer({
      poolAddress,
      provider,
      network
    });
    if (indexerData) {
      data = indexerData;
      tierUsed = 3;
      sourceTrace.push({
        source: "indexer_sql",
        tier: 3,
        status: "success"
      });
    } else {
      sourceTrace.push({
        source: "indexer_sql",
        tier: 3,
        status: "empty",
        reason: "no compatible pool record"
      });
    }
  }

  if (!data) {
    sourceTrace.push({
      source: "internet",
      tier: 4,
      status: "skipped",
      reason: "manual lookup only"
    });
    throw new MantleMcpError(
      "POOL_NOT_FOUND",
      `Pool not found: ${poolAddress}`,
      "Verify the pool address and provider.",
      { pool_address: poolAddress, provider, network, source_trace: sourceTrace }
    );
  }

  const reserve0Raw = parseRawAmount(data.reserve_0_raw, "reserve_0_raw", {
    pool_address: poolAddress,
    provider,
    network
  });
  const reserve1Raw = parseRawAmount(data.reserve_1_raw, "reserve_1_raw", {
    pool_address: poolAddress,
    provider,
    network
  });

  const reserve0Decimal =
    data.token_0.decimals == null ? null : formatUnits(reserve0Raw, data.token_0.decimals);
  const reserve1Decimal =
    data.token_1.decimals == null ? null : formatUnits(reserve1Raw, data.token_1.decimals);

  const warnings: string[] = [];
  let hasConflict = false;
  let totalLiquidityUsdRange: { min: number; max: number } | null = null;
  let totalLiquidityUsd = typeof data.total_liquidity_usd === "number" ? data.total_liquidity_usd : null;
  let derivedLiquidityUsd: number | null = null;

  if (
    data.token_0.decimals != null &&
    data.token_1.decimals != null
  ) {
    const priceLookup = unpackTokenPriceLookup(await resolvedDeps.getTokenPrices({
      network,
      tokenAddresses: [data.token_0.address, data.token_1.address]
    }));
    const priceMap = priceLookup.prices;
    if (Array.isArray(priceLookup.source_trace)) {
      sourceTrace.push(...priceLookup.source_trace);
    }

    const token0Price = priceMap[data.token_0.address.toLowerCase()] ?? null;
    const token1Price = priceMap[data.token_1.address.toLowerCase()] ?? null;

    if (typeof token0Price === "number" && typeof token1Price === "number") {
      const derived = deriveLiquidityUsdFromReserves(
        reserve0Raw,
        reserve1Raw,
        data.token_0.decimals,
        data.token_1.decimals,
        token0Price,
        token1Price
      );
      if (Number.isFinite(derived)) {
        derivedLiquidityUsd = derived;
      }
    }
  }

  if (totalLiquidityUsd == null && derivedLiquidityUsd != null) {
    totalLiquidityUsd = derivedLiquidityUsd;
  }

  if (totalLiquidityUsd != null && derivedLiquidityUsd != null) {
    const baseline = Math.max(totalLiquidityUsd, derivedLiquidityUsd);
    if (baseline > 0) {
      const deltaRatio = Math.abs(totalLiquidityUsd - derivedLiquidityUsd) / baseline;
      if (deltaRatio > 0.2) {
        hasConflict = true;
        totalLiquidityUsdRange = {
          min: Math.min(totalLiquidityUsd, derivedLiquidityUsd),
          max: Math.max(totalLiquidityUsd, derivedLiquidityUsd)
        };
        warnings.push("Liquidity USD conflict across sources; returning range.");
      }
    }
  }

  if (totalLiquidityUsd == null) {
    warnings.push("total_liquidity_usd is null due to unavailable valuation source.");
  }

  const coverage =
    [
      data.token_0.address,
      data.token_1.address,
      data.reserve_0_raw,
      data.reserve_1_raw,
      totalLiquidityUsd == null ? null : "liquidity"
    ].filter((value) => value != null && String(value).length > 0).length / 5;
  const confidence = buildConfidence({
    coverage,
    tierUsed,
    successfulSources: sourceTrace.filter((item) => item.status === "success").length,
    conflict: hasConflict
  });

  return {
    intent: "pool_liquidity",
    pool_address: poolAddress,
    provider,
    token_0: data.token_0,
    token_1: data.token_1,
    reserve_0_raw: reserve0Raw.toString(),
    reserve_0_decimal: reserve0Decimal,
    reserve_1_raw: reserve1Raw.toString(),
    reserve_1_decimal: reserve1Decimal,
    total_liquidity_usd: totalLiquidityUsd,
    total_liquidity_usd_range: totalLiquidityUsdRange,
    fee_tier: data.fee_tier,
    collected_at_utc: resolvedDeps.now(),
    source_trace: sourceTrace,
    confidence,
    warnings
  };
}

export async function getLendingMarkets(
  args: Record<string, unknown>,
  deps?: Partial<LendingMarketsDeps>
): Promise<any> {
  const resolvedDeps = withLendingDeps(deps);
  const { network } = normalizeNetwork(args);
  const protocolInput = typeof args.protocol === "string" ? args.protocol : "all";
  const asset = typeof args.asset === "string" ? args.asset : null;

  const protocol =
    protocolInput === "aave" ? "aave_v3" : protocolInput;

  if (!["all", "aave_v3"].includes(protocol)) {
    throw new MantleMcpError(
      "UNSUPPORTED_PROTOCOL",
      `Unsupported lending protocol: ${protocolInput}`,
      "Use protocol=aave_v3, aave, or all.",
      { protocol: protocolInput }
    );
  }

  const sourceTrace: SourceTraceEntry[] = [];
  let tierUsed = 1;
  let allMarkets = await resolvedDeps.marketProvider({ protocol: "aave_v3", network });
  if (allMarkets.length > 0) {
    sourceTrace.push({
      source: "onchain_aave",
      tier: 1,
      status: "success"
    });
  } else {
    sourceTrace.push({
      source: "onchain_aave",
      tier: 1,
      status: "empty",
      reason: "no markets returned"
    });
  }

  if (allMarkets.length === 0) {
    const subgraphMarkets = await resolvedDeps.marketProviderFromSubgraph({
      protocol: "aave_v3",
      network
    });
    if (subgraphMarkets.length > 0) {
      allMarkets = subgraphMarkets;
      tierUsed = 2;
      sourceTrace.push({
        source: "subgraph",
        tier: 2,
        status: "success"
      });
    } else {
      sourceTrace.push({
        source: "subgraph",
        tier: 2,
        status: "empty",
        reason: "no markets returned"
      });
    }
  }

  if (allMarkets.length === 0) {
    const indexerMarkets = await resolvedDeps.marketProviderFromIndexer({
      protocol: "aave_v3",
      network
    });
    if (indexerMarkets.length > 0) {
      allMarkets = indexerMarkets;
      tierUsed = 3;
      sourceTrace.push({
        source: "indexer_sql",
        tier: 3,
        status: "success"
      });
    } else {
      sourceTrace.push({
        source: "indexer_sql",
        tier: 3,
        status: "empty",
        reason: "no markets returned"
      });
    }
  }

  if (allMarkets.length === 0 && network === "mainnet" && protocol === "aave_v3") {
    throw new MantleMcpError(
      "LENDING_DATA_UNAVAILABLE",
      "No Aave V3 market data could be retrieved for Mantle mainnet.",
      "Retry after checking RPC health, or run mantle_checkRpcHealth first.",
      { protocol: "aave_v3", network, source_trace: sourceTrace }
    );
  }

  const filteredMarkets = asset
    ? allMarkets.filter(
        (market) =>
          market.asset.toLowerCase() === asset.toLowerCase() ||
          market.asset_address.toLowerCase() === asset.toLowerCase()
      )
    : allMarkets;

  const confidence = buildConfidence({
    coverage: allMarkets.length > 0 ? 1 : 0,
    tierUsed,
    successfulSources: sourceTrace.filter((item) => item.status === "success").length,
    conflict: false
  });

  return {
    intent: "protocol_lending_markets",
    markets: filteredMarkets,
    collected_at_utc: resolvedDeps.now(),
    partial: tierUsed > 1,
    source_trace: sourceTrace,
    confidence
  };
}

async function resolveSingleProtocolTvl(params: {
  protocol: ProtocolTvlKey;
  network: "mainnet" | "sepolia";
  deps: ProtocolTvlDeps;
}): Promise<{
  protocol: ProtocolTvlKey;
  tvl_usd: number | null;
  tvl_usd_range: { min: number; max: number } | null;
  updated_at_utc: string | null;
  source: string | null;
  tier_used: number;
  source_trace: SourceTraceEntry[];
  warnings: string[];
  confidence: ConfidenceScore;
  partial: boolean;
}> {
  const { protocol, network, deps } = params;
  const sourceTrace: SourceTraceEntry[] = [];
  const warnings: string[] = [];
  const values: Array<{
    source: string;
    tier: number;
    tvl_usd: number;
    updated_at_unix: number | null;
  }> = [];

  const defillamaValue = normalizeProtocolTvlValue(
    await deps.protocolTvlProvider({ protocol, network })
  );
  if (defillamaValue) {
    values.push({
      source: "defillama_protocol",
      tier: 1,
      tvl_usd: defillamaValue.tvl_usd,
      updated_at_unix: defillamaValue.updated_at_unix
    });
    sourceTrace.push({
      source: "defillama_protocol",
      tier: 1,
      status: "success"
    });
  } else {
    sourceTrace.push({
      source: "defillama_protocol",
      tier: 1,
      status: "empty",
      reason: "no protocol tvl returned"
    });
  }

  const subgraphValue = normalizeProtocolTvlValue(
    await deps.protocolTvlFromSubgraph({ protocol, network })
  );
  if (subgraphValue) {
    values.push({
      source: "subgraph",
      tier: 2,
      tvl_usd: subgraphValue.tvl_usd,
      updated_at_unix: subgraphValue.updated_at_unix
    });
    sourceTrace.push({
      source: "subgraph",
      tier: 2,
      status: "success"
    });
  } else {
    sourceTrace.push({
      source: "subgraph",
      tier: 2,
      status: "empty",
      reason: "no protocol tvl returned"
    });
  }

  const indexerValue = normalizeProtocolTvlValue(
    await deps.protocolTvlFromIndexer({ protocol, network })
  );
  if (indexerValue) {
    values.push({
      source: "indexer_sql",
      tier: 3,
      tvl_usd: indexerValue.tvl_usd,
      updated_at_unix: indexerValue.updated_at_unix
    });
    sourceTrace.push({
      source: "indexer_sql",
      tier: 3,
      status: "success"
    });
  } else {
    sourceTrace.push({
      source: "indexer_sql",
      tier: 3,
      status: "empty",
      reason: "no protocol tvl returned"
    });
  }

  sourceTrace.push({
    source: "internet",
    tier: 4,
    status: "skipped",
    reason: "manual verification only"
  });

  const ordered = [...values].sort((left, right) => left.tier - right.tier);
  const primary = ordered[0] ?? null;

  let hasConflict = false;
  let tvlRange: { min: number; max: number } | null = null;
  if (values.length >= 2) {
    const tvls = values.map((item) => item.tvl_usd);
    const min = Math.min(...tvls);
    const max = Math.max(...tvls);
    if (max > 0 && Math.abs(max - min) / max > 0.2) {
      hasConflict = true;
      tvlRange = { min, max };
      warnings.push("Protocol TVL conflict across sources; returning range.");
    }
  }

  const tierUsed = primary?.tier ?? 4;
  const confidence = buildConfidence({
    coverage: primary ? 1 : 0,
    tierUsed,
    successfulSources: values.length,
    conflict: hasConflict
  });

  return {
    protocol,
    tvl_usd: primary?.tvl_usd ?? null,
    tvl_usd_range: tvlRange,
    updated_at_utc:
      primary?.updated_at_unix != null
        ? new Date(primary.updated_at_unix * 1000).toISOString()
        : null,
    source: primary?.source ?? null,
    tier_used: tierUsed,
    source_trace: sourceTrace,
    warnings,
    confidence,
    partial: tierUsed > 1
  };
}

export async function getProtocolTvl(
  args: Record<string, unknown>,
  deps?: Partial<ProtocolTvlDeps>
): Promise<any> {
  const resolvedDeps = withProtocolTvlDeps(deps);
  const { network } = normalizeNetwork(args);
  const protocolInput = typeof args.protocol === "string" ? args.protocol : "all";
  const protocol = normalizeProtocolInput(protocolInput);
  const targets: ProtocolTvlKey[] = protocol === "all" ? ["agni", "merchant_moe"] : [protocol];

  const breakdown = await Promise.all(
    targets.map((target) =>
      resolveSingleProtocolTvl({
        protocol: target,
        network,
        deps: resolvedDeps
      })
    )
  );

  if (protocol !== "all" && breakdown[0]?.tvl_usd == null) {
    throw new MantleMcpError(
      "TVL_DATA_UNAVAILABLE",
      `No protocol TVL data available for ${protocol}.`,
      "Check DefiLlama/subgraph/indexer reachability and retry.",
      {
        protocol,
        network,
        source_trace: breakdown[0]?.source_trace ?? []
      }
    );
  }

  const successful = breakdown.filter((item) => item.tvl_usd != null);
  const totalTvl =
    protocol === "all"
      ? successful.reduce((sum, item) => sum + (item.tvl_usd ?? 0), 0)
      : (breakdown[0]?.tvl_usd ?? null);
  const totalRange =
    protocol === "all"
      ? null
      : (breakdown[0]?.tvl_usd_range ?? null);

  const sourceTrace =
    protocol === "all"
      ? breakdown.flatMap((item) =>
          item.source_trace.map((trace) => ({
            ...trace,
            source: `${trace.source}:${item.protocol}`
          }))
        )
      : (breakdown[0]?.source_trace ?? []);
  const warnings = breakdown.flatMap((item) => item.warnings);
  const tierUsed =
    successful.length > 0
      ? Math.min(...successful.map((item) => item.tier_used))
      : 4;
  const confidence = buildConfidence({
    coverage:
      protocol === "all" ? successful.length / targets.length : successful.length > 0 ? 1 : 0,
    tierUsed,
    successfulSources: sourceTrace.filter((item) => item.status === "success").length,
    conflict: warnings.some((item) => item.toLowerCase().includes("conflict"))
  });

  return {
    intent: "protocol_tvl",
    protocol,
    network,
    tvl_usd: totalTvl,
    tvl_usd_range: totalRange,
    breakdown: breakdown.map((item) => ({
      protocol: item.protocol,
      tvl_usd: item.tvl_usd,
      tvl_usd_range: item.tvl_usd_range,
      updated_at_utc: item.updated_at_utc,
      source: item.source,
      partial: item.partial
    })),
    collected_at_utc: resolvedDeps.now(),
    partial: breakdown.some((item) => item.partial) || successful.length < targets.length,
    source_trace: sourceTrace,
    confidence,
    warnings
  };
}

export const defiReadTools: Record<string, Tool> = {
  getSwapQuote: {
    name: "mantle_getSwapQuote",
    description:
      "Read swap quotes for Agni and Merchant Moe routes. Examples: WMNT 0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8 to USDC 0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9 via Agni router 0x319B69888b0d11cEC22caA5034e25FfFBDc88421.",
    inputSchema: {
      type: "object",
      properties: {
        token_in: { type: "string", description: "Input token symbol/address." },
        token_out: { type: "string", description: "Output token symbol/address." },
        amount_in: { type: "string", description: "Human-readable amount in." },
        provider: {
          type: "string",
          enum: ["agni", "fluxion", "merchant_moe", "best"],
          description: "Routing provider"
        },
        fee_tier: { type: "number", description: "Optional V3 fee tier." },
        network: { type: "string", enum: ["mainnet", "sepolia"], description: "Network" }
      },
      required: ["token_in", "token_out", "amount_in"]
    },
    handler: getSwapQuote
  },
  getPoolLiquidity: {
    name: "mantle_getPoolLiquidity",
    description:
      "Read pool reserves and liquidity metadata. Examples: inspect a Mantle DEX pool for USDC 0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9 / USDT 0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE liquidity.",
    inputSchema: {
      type: "object",
      properties: {
        pool_address: { type: "string", description: "Pool contract address." },
        provider: {
          type: "string",
          enum: ["agni", "merchant_moe"],
          description: "DEX provider"
        },
        network: { type: "string", enum: ["mainnet", "sepolia"], description: "Network" }
      },
      required: ["pool_address"]
    },
    handler: getPoolLiquidity
  },
  getPoolOpportunities: {
    name: "mantle_getPoolOpportunities",
    description:
      "Scan and rank candidate pools for a token pair on Mantle DEXes. Examples: token_a='MNT' (native mapped to WMNT 0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8), token_b='mETH' 0xcDA86A272531e8640cD7F1a92c01839911B90bb0.",
    inputSchema: {
      type: "object",
      properties: {
        token_a: { type: "string", description: "First token symbol/address." },
        token_b: { type: "string", description: "Second token symbol/address." },
        provider: {
          type: "string",
          enum: ["agni", "merchant_moe", "all"],
          description: "Optional DEX provider filter."
        },
        max_results: { type: "number", description: "Max candidates returned (1-10)." },
        network: { type: "string", enum: ["mainnet", "sepolia"], description: "Network" }
      },
      required: ["token_a", "token_b"]
    },
    handler: getPoolOpportunities
  },
  getProtocolTvl: {
    name: "mantle_getProtocolTvl",
    description:
      "Read protocol-level TVL for Mantle DeFi protocols using layered sources. Examples: protocol=agni for Agni Finance TVL, protocol=merchant_moe for Merchant Moe TVL, protocol=all for combined view.",
    inputSchema: {
      type: "object",
      properties: {
        protocol: {
          type: "string",
          enum: ["agni", "merchant_moe", "all"],
          description: "Protocol selector for TVL query."
        },
        network: { type: "string", enum: ["mainnet", "sepolia"], description: "Network" }
      },
      required: []
    },
    handler: getProtocolTvl
  },
  getLendingMarkets: {
    name: "mantle_getLendingMarkets",
    description:
      "Read Aave v3 lending market metrics on Mantle. Examples: USDC market 0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9 with pool 0x458F293454fE0d67EC0655f3672301301DD51422.",
    inputSchema: {
      type: "object",
      properties: {
        protocol: {
          type: "string",
          enum: ["aave_v3", "aave", "all"],
          description: "Lending protocol selector"
        },
        asset: { type: "string", description: "Optional asset filter." },
        network: { type: "string", enum: ["mainnet", "sepolia"], description: "Network" }
      },
      required: []
    },
    handler: getLendingMarkets
  }
};
