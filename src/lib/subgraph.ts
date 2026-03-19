/**
 * External data source helpers for Mantle DeFi protocols.
 *
 * Tier 2 data sources — used as fallback when DexScreener / on-chain RPC (Tier 1)
 * returns no data.
 *
 * - Agni V3: GraphQL subgraph at agni.finance
 * - Merchant Moe: REST API at barn.merchantmoe.com
 * - Aave V3: AaveKit GraphQL API at api.v3.aave.com
 */

import { getAddress, isAddress } from "viem";

const AGNI_V3_SUBGRAPH = "https://agni.finance/graph/subgraphs/name/agni/exchange-v3";
const MERCHANT_MOE_BARN_API = "https://barn.merchantmoe.com/v1/lb/pools/mantle";
const AAVE_V3_API = "https://api.v3.aave.com/graphql";
const MANTLE_CHAIN_ID = 5000;

/** Timeout for external API queries (ms). */
const QUERY_TIMEOUT = 10_000;

// ─── Shared types ───────────────────────────────────────────────────────────

export interface SubgraphPoolResult {
  token_0: { address: string; symbol: string | null; decimals: number | null };
  token_1: { address: string; symbol: string | null; decimals: number | null };
  reserve_0_raw: string;
  reserve_1_raw: string;
  fee_tier: number | null;
  total_liquidity_usd: number | null;
}

export interface ExternalLendingMarket {
  protocol: string;
  asset: string;
  asset_address: string;
  supply_apy: number | null;
  borrow_apy_variable: number | null;
  borrow_apy_stable: number | null;
  tvl_usd: number | null;
  ltv: number | null;
  liquidation_threshold: number | null;
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function queryGraphQL(endpoint: string, query: string): Promise<unknown> {
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return await response.json();
}

function tvlTokenToRaw(tvlDecimal: string | null | undefined, decimals: number): string {
  if (!tvlDecimal) return "0";
  try {
    const [intPart, fracPart = ""] = tvlDecimal.split(".");
    const padded = (fracPart + "0".repeat(decimals)).slice(0, decimals);
    const raw = intPart + padded;
    return raw.replace(/^0+/, "") || "0";
  } catch {
    return "0";
  }
}

function decimalToRaw(value: number | null | undefined, decimals: number): string {
  if (value == null || !Number.isFinite(value)) return "0";
  return tvlTokenToRaw(value.toString(), decimals);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ─── Agni V3 Subgraph ──────────────────────────────────────────────────────

interface AgniPoolResponse {
  data?: {
    pool?: {
      id: string;
      token0: { id: string; symbol: string; decimals: string };
      token1: { id: string; symbol: string; decimals: string };
      liquidity: string;
      totalValueLockedToken0: string;
      totalValueLockedToken1: string;
      totalValueLockedUSD: string;
      feeTier: string;
    } | null;
  };
}

export async function fetchAgniPoolFromSubgraph(
  poolAddress: string
): Promise<SubgraphPoolResult | null> {
  if (!isAddress(poolAddress, { strict: false })) return null;

  const query = `{
    pool(id: "${poolAddress.toLowerCase()}") {
      id
      token0 { id symbol decimals }
      token1 { id symbol decimals }
      liquidity
      totalValueLockedToken0
      totalValueLockedToken1
      totalValueLockedUSD
      feeTier
    }
  }`;

  try {
    const result = (await queryGraphQL(AGNI_V3_SUBGRAPH, query)) as AgniPoolResponse;
    const pool = result?.data?.pool;
    if (!pool) return null;

    const decimals0 = parseInt(pool.token0.decimals, 10);
    const decimals1 = parseInt(pool.token1.decimals, 10);
    const tvlUsd = parseFloat(pool.totalValueLockedUSD);

    return {
      token_0: {
        address: getAddress(pool.token0.id),
        symbol: pool.token0.symbol || null,
        decimals: Number.isFinite(decimals0) ? decimals0 : null,
      },
      token_1: {
        address: getAddress(pool.token1.id),
        symbol: pool.token1.symbol || null,
        decimals: Number.isFinite(decimals1) ? decimals1 : null,
      },
      reserve_0_raw: tvlTokenToRaw(pool.totalValueLockedToken0, Number.isFinite(decimals0) ? decimals0 : 18),
      reserve_1_raw: tvlTokenToRaw(pool.totalValueLockedToken1, Number.isFinite(decimals1) ? decimals1 : 18),
      fee_tier: pool.feeTier ? parseInt(pool.feeTier, 10) : null,
      total_liquidity_usd: Number.isFinite(tvlUsd) ? tvlUsd : null,
    };
  } catch {
    return null;
  }
}

// ─── Merchant Moe Barn REST API ─────────────────────────────────────────────

interface BarnPool {
  pairAddress: string;
  tokenX: { address: string; symbol: string; decimals: number };
  tokenY: { address: string; symbol: string; decimals: number };
  reserveX: number;
  reserveY: number;
  lbBinStep: number;
  lbBaseFeePct: number;
  liquidityUsd: number;
}

let barnPoolsCache: { data: BarnPool[]; fetchedAt: number } | null = null;
const BARN_CACHE_TTL = 60_000; // 1 minute

async function fetchBarnPools(): Promise<BarnPool[]> {
  const now = Date.now();
  if (barnPoolsCache && now - barnPoolsCache.fetchedAt < BARN_CACHE_TTL) {
    return barnPoolsCache.data;
  }
  const response = await fetchWithTimeout(MERCHANT_MOE_BARN_API);
  const data = (await response.json()) as BarnPool[];
  if (!Array.isArray(data)) return [];
  barnPoolsCache = { data, fetchedAt: now };
  return data;
}

export async function fetchMerchantMoePoolFromBarn(
  poolAddress: string
): Promise<SubgraphPoolResult | null> {
  if (!isAddress(poolAddress, { strict: false })) return null;

  try {
    const pools = await fetchBarnPools();
    const normalized = poolAddress.toLowerCase();
    const pool = pools.find((p) => p.pairAddress?.toLowerCase() === normalized);
    if (!pool) return null;

    return {
      token_0: {
        address: getAddress(pool.tokenX.address),
        symbol: pool.tokenX.symbol || null,
        decimals: pool.tokenX.decimals ?? null,
      },
      token_1: {
        address: getAddress(pool.tokenY.address),
        symbol: pool.tokenY.symbol || null,
        decimals: pool.tokenY.decimals ?? null,
      },
      reserve_0_raw: decimalToRaw(pool.reserveX, pool.tokenX.decimals ?? 18),
      reserve_1_raw: decimalToRaw(pool.reserveY, pool.tokenY.decimals ?? 18),
      fee_tier: pool.lbBinStep ?? null,
      total_liquidity_usd: toFiniteNumber(pool.liquidityUsd),
    };
  } catch {
    return null;
  }
}

// ─── Aave V3 AaveKit API ───────────────────────────────────────────────────

interface AaveKitResponse {
  data?: {
    markets?: Array<{
      name: string;
      reserves: Array<{
        underlyingToken: { symbol: string; decimals: number; address: string };
        usdExchangeRate?: string;
        supplyInfo?: {
          apy?: { value?: string };
          total?: { value?: string };
          maxLTV?: { value?: string };
        };
        borrowInfo?: {
          apy?: { value?: string };
        };
        liquidationThreshold?: { value?: string };
      }>;
    }>;
  };
}

export async function fetchAaveMarketsFromApi(): Promise<ExternalLendingMarket[]> {
  const query = `{
    markets(request: { chainIds: [${MANTLE_CHAIN_ID}] }) {
      name
      reserves {
        underlyingToken { symbol decimals address }
        usdExchangeRate
        supplyInfo {
          apy { value }
          total { value }
          maxLTV { value }
        }
        borrowInfo {
          apy { value }
        }
        liquidationThreshold { value }
      }
    }
  }`;

  try {
    const result = (await queryGraphQL(AAVE_V3_API, query)) as AaveKitResponse;
    const markets = result?.data?.markets;
    if (!markets || markets.length === 0) return [];

    const mantleMarket = markets.find((m) => m.name?.includes("Mantle"));
    if (!mantleMarket) return [];

    return mantleMarket.reserves
      .map((r): ExternalLendingMarket | null => {
        const token = r.underlyingToken;
        if (!token?.address) return null;

        const supplyApy = toFiniteNumber(r.supplyInfo?.apy?.value);
        const borrowApy = toFiniteNumber(r.borrowInfo?.apy?.value);
        const ltv = toFiniteNumber(r.supplyInfo?.maxLTV?.value);
        const liqThreshold = toFiniteNumber(r.liquidationThreshold?.value);
        const totalSupplyUsd = toFiniteNumber(r.supplyInfo?.total?.value);
        const exchangeRate = toFiniteNumber(r.usdExchangeRate);
        const tvlUsd =
          totalSupplyUsd != null && exchangeRate != null
            ? totalSupplyUsd * exchangeRate
            : null;

        return {
          protocol: "aave_v3",
          asset: token.symbol,
          asset_address: token.address,
          supply_apy: supplyApy,
          borrow_apy_variable: borrowApy,
          borrow_apy_stable: null,
          tvl_usd: tvlUsd,
          ltv: ltv,
          liquidation_threshold: liqThreshold,
        };
      })
      .filter((m): m is ExternalLendingMarket => m !== null);
  } catch {
    return [];
  }
}
