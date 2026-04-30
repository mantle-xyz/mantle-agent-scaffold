/**
 * Shared on-chain pool discovery for V3 DEXes (Agni / Fluxion).
 *
 * Used by both defi-read (quote) and defi-write (build) to ensure
 * they select the same pool when fee_tier is not explicitly provided.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** V3 fee tiers to probe (hundredths of a basis point). */
export const V3_FEE_TIER_CANDIDATES = [100, 500, 2500, 3000, 10000] as const;

// ---------------------------------------------------------------------------
// Inline ABIs — kept minimal to avoid importing the full ABI files.
// ---------------------------------------------------------------------------

const V3_FACTORY_GET_POOL_ABI = [
  {
    type: "function" as const,
    name: "getPool" as const,
    stateMutability: "view" as const,
    inputs: [
      { name: "", type: "address" as const },
      { name: "", type: "address" as const },
      { name: "", type: "uint24" as const }
    ],
    outputs: [{ name: "", type: "address" as const }]
  }
] as const;

const POOL_LIQUIDITY_ABI = [
  {
    type: "function" as const,
    name: "liquidity" as const,
    stateMutability: "view" as const,
    inputs: [],
    outputs: [{ name: "", type: "uint128" as const }]
  }
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredPool {
  feeTier: number;
  poolAddress: string;
  liquidity: bigint;
  liquidityRank?: number;
}

/** Minimal viem-compatible multicall client. */
export interface MulticallClient {
  multicall: (args: { contracts: readonly any[] }) => Promise<any[]>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Query the V3 factory on-chain for all common fee tiers and return the
 * pool with the highest liquidity. Returns null if no pool with non-zero
 * liquidity exists.
 *
 * @param client       viem public client (must support multicall)
 * @param factory      V3 factory contract address
 * @param tokenA       first token address
 * @param tokenB       second token address
 */
export async function discoverBestV3Pool(
  client: MulticallClient,
  factory: `0x${string}`,
  tokenA: `0x${string}`,
  tokenB: `0x${string}`,
  options: { minLiquidityThreshold?: bigint } = {}
): Promise<DiscoveredPool | null> {
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

  // Step 1: query factory for all fee tiers
  const factoryCalls = V3_FEE_TIER_CANDIDATES.map((fee) => ({
    address: factory,
    abi: V3_FACTORY_GET_POOL_ABI,
    functionName: "getPool" as const,
    args: [tokenA, tokenB, fee] as const
  }));

  const factoryResults = await client.multicall({ contracts: factoryCalls });

  // Collect pools that exist
  const existingPools: Array<{ fee: number; poolAddress: `0x${string}` }> = [];
  for (let i = 0; i < V3_FEE_TIER_CANDIDATES.length; i++) {
    const result = factoryResults[i];
    if (result.status === "success" && result.result && result.result !== ZERO_ADDR) {
      existingPools.push({
        fee: V3_FEE_TIER_CANDIDATES[i],
        poolAddress: result.result as `0x${string}`
      });
    }
  }

  if (existingPools.length === 0) {
    return null;
  }

  // Step 2: read liquidity from each pool
  const liqCalls = existingPools.map((p) => ({
    address: p.poolAddress,
    abi: POOL_LIQUIDITY_ABI,
    functionName: "liquidity" as const
  }));

  const liqResults = await client.multicall({ contracts: liqCalls });

  const candidates: DiscoveredPool[] = [];
  for (let i = 0; i < existingPools.length; i++) {
    const liq = liqResults[i].status === "success" ? (liqResults[i].result as bigint) : 0n;
    if (liq > 0n) {
      candidates.push({
        feeTier: existingPools[i].fee,
        poolAddress: existingPools[i].poolAddress,
        liquidity: liq
      });
    }
  }

  candidates.sort((a, b) => (a.liquidity > b.liquidity ? -1 : a.liquidity < b.liquidity ? 1 : 0));
  const ranked = candidates.map((pool, index) => ({ ...pool, liquidityRank: index + 1 }));
  return ranked.find((pool) => pool.liquidity >= (options.minLiquidityThreshold ?? 1n)) ?? null;
}

/**
 * Return all V3 pools with non-zero liquidity for a token pair.
 * Useful for multi-hop route exploration where the "best" single pool
 * isn't always the right choice.
 */
export async function discoverAllV3Pools(
  client: MulticallClient,
  factory: `0x${string}`,
  tokenA: `0x${string}`,
  tokenB: `0x${string}`
): Promise<DiscoveredPool[]> {
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

  const factoryCalls = V3_FEE_TIER_CANDIDATES.map((fee) => ({
    address: factory,
    abi: V3_FACTORY_GET_POOL_ABI,
    functionName: "getPool" as const,
    args: [tokenA, tokenB, fee] as const
  }));

  const factoryResults = await client.multicall({ contracts: factoryCalls });

  const existingPools: Array<{ fee: number; poolAddress: `0x${string}` }> = [];
  for (let i = 0; i < V3_FEE_TIER_CANDIDATES.length; i++) {
    const result = factoryResults[i];
    if (result.status === "success" && result.result && result.result !== ZERO_ADDR) {
      existingPools.push({
        fee: V3_FEE_TIER_CANDIDATES[i],
        poolAddress: result.result as `0x${string}`
      });
    }
  }

  if (existingPools.length === 0) {
    return [];
  }

  const liqCalls = existingPools.map((p) => ({
    address: p.poolAddress,
    abi: POOL_LIQUIDITY_ABI,
    functionName: "liquidity" as const
  }));

  const liqResults = await client.multicall({ contracts: liqCalls });

  const pools: DiscoveredPool[] = [];
  for (let i = 0; i < existingPools.length; i++) {
    const liq = liqResults[i].status === "success" ? (liqResults[i].result as bigint) : 0n;
    if (liq > 0n) {
      pools.push({
        feeTier: existingPools[i].fee,
        poolAddress: existingPools[i].poolAddress,
        liquidity: liq,
        liquidityRank: 0
      });
    }
  }

  pools.sort((a, b) => (a.liquidity > b.liquidity ? -1 : a.liquidity < b.liquidity ? 1 : 0));
  pools.forEach((pool, index) => {
    pool.liquidityRank = index + 1;
  });
  return pools;
}
