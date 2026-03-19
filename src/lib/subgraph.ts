/**
 * Subgraph query helpers for Mantle DeFi protocols.
 *
 * Tier 2 data source — used as fallback when DexScreener (Tier 1) returns no data.
 * Currently supports Agni V3 only; Merchant Moe has no public subgraph endpoint.
 */

import { getAddress, isAddress } from "viem";

const AGNI_V3_SUBGRAPH = "https://agni.finance/graph/subgraphs/name/agni/exchange-v3";

/** Timeout for subgraph queries (ms). */
const SUBGRAPH_TIMEOUT = 10_000;

interface SubgraphPoolResult {
  token_0: { address: string; symbol: string | null; decimals: number | null };
  token_1: { address: string; symbol: string | null; decimals: number | null };
  reserve_0_raw: string;
  reserve_1_raw: string;
  fee_tier: number | null;
  total_liquidity_usd: number | null;
}

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
  errors?: Array<{ message: string }>;
}

async function querySubgraph(endpoint: string, query: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBGRAPH_TIMEOUT);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * tvlTokenToRaw — convert a decimal TVL string (e.g. "1234.567890") to raw units
 * using the token's decimals. This is a best-effort conversion; returns "0" on failure.
 */
function tvlTokenToRaw(tvlDecimal: string | null | undefined, decimals: number): string {
  if (!tvlDecimal) return "0";
  try {
    // Split on decimal point and pad/truncate fractional part
    const [intPart, fracPart = ""] = tvlDecimal.split(".");
    const padded = (fracPart + "0".repeat(decimals)).slice(0, decimals);
    const raw = intPart + padded;
    // Remove leading zeros but keep at least "0"
    return raw.replace(/^0+/, "") || "0";
  } catch {
    return "0";
  }
}

/**
 * Fetch pool data from Agni V3 subgraph.
 * Returns null if the pool doesn't exist or the query fails.
 */
export async function fetchAgniPoolFromSubgraph(
  poolAddress: string
): Promise<SubgraphPoolResult | null> {
  if (!isAddress(poolAddress, { strict: false })) return null;

  const normalizedAddress = poolAddress.toLowerCase();
  const query = `{
    pool(id: "${normalizedAddress}") {
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
    const result = (await querySubgraph(AGNI_V3_SUBGRAPH, query)) as AgniPoolResponse;
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
