/**
 * DeFi LP Read Tools — on-chain reads for Uniswap V3 (Agni / Fluxion) pools
 * and Merchant Moe Liquidity Book pairs on Mantle.
 *
 * All tools are pure reads — no state mutation, no private keys.
 */

import { formatUnits, getAddress, isAddress } from "viem";
import { MANTLE_PROTOCOLS } from "../config/protocols.js";
import { MantleMcpError } from "../errors.js";
import { getPublicClient } from "../lib/clients.js";
import { normalizeNetwork } from "../lib/network.js";
import {
  resolveTokenInput as resolveTokenInputFromRegistry,
  type ResolvedTokenInput
} from "../lib/token-registry.js";
import type { Tool, Network } from "../types.js";

// ABIs
import {
  V3_POOL_ABI,
  V3_FACTORY_ABI,
  V3_POSITION_MANAGER_ABI
} from "../lib/abis/uniswap-v3.js";
import {
  LB_PAIR_ABI,
  LB_FACTORY_ABI
} from "../lib/abis/merchant-moe-lb.js";
import { listPairs, type MoePair } from "../config/dex-pairs.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type V3Provider = "agni" | "fluxion";
const V3_PROVIDERS = new Set<V3Provider>(["agni", "fluxion"]);

interface TokenInfo {
  address: string;
  symbol: string | null;
  decimals: number | null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function requireAddress(input: unknown, fieldName: string): `0x${string}` {
  if (typeof input !== "string" || !isAddress(input, { strict: false })) {
    throw new MantleMcpError(
      "INVALID_ADDRESS",
      `${fieldName} must be a valid address.`,
      "Provide an EIP-55 address string.",
      { field: fieldName, value: input ?? null }
    );
  }
  return getAddress(input) as `0x${string}`;
}

function requireString(input: unknown, fieldName: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `${fieldName} is required.`,
      `Provide a non-empty string for ${fieldName}.`,
      { field: fieldName }
    );
  }
  return input.trim();
}

function getContractAddress(
  protocol: string,
  contractKey: string,
  network: Network
): `0x${string}` {
  const proto = MANTLE_PROTOCOLS[network]?.[protocol];
  if (!proto) {
    throw new MantleMcpError(
      "UNSUPPORTED_PROTOCOL",
      `Protocol '${protocol}' not found on ${network}.`,
      "Check available protocols.",
      { protocol, network }
    );
  }
  const addr = proto.contracts[contractKey];
  if (!addr || addr.startsWith("BLOCKER")) {
    throw new MantleMcpError(
      "UNSUPPORTED_PROTOCOL",
      `Contract '${contractKey}' for ${protocol} not available on ${network}.`,
      "This contract may not be deployed yet.",
      { protocol, contractKey, network }
    );
  }
  return addr as `0x${string}`;
}

async function resolveTokenInfo(
  identifier: string,
  network: Network
): Promise<TokenInfo> {
  const resolved = await resolveTokenInputFromRegistry(identifier, network);
  return {
    address: resolved.address,
    symbol: resolved.symbol,
    decimals: resolved.decimals
  };
}

function nowUtc(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// V3 price math
// ---------------------------------------------------------------------------

/**
 * Compute human-readable price from sqrtPriceX96.
 *
 * price_token0_per_token1 = (sqrtPriceX96 / 2^96)^2 * 10^(decimals0 - decimals1)
 *
 * We perform the computation in floating point which is sufficient for display.
 */
function priceFromSqrtX96(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number
): { price_token0_per_token1: number; price_token1_per_token0: number } {
  const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
  const rawPrice = sqrtPrice * sqrtPrice; // token1 per token0 in raw terms
  const decimalAdjustment = 10 ** (decimals0 - decimals1);
  const price_token1_per_token0 = rawPrice * decimalAdjustment;
  const price_token0_per_token1 =
    price_token1_per_token0 !== 0 ? 1 / price_token1_per_token0 : 0;
  return { price_token0_per_token1, price_token1_per_token0 };
}

/**
 * Convert a single tick to a human-readable price.
 * price = 1.0001^tick * 10^(decimals0 - decimals1)
 */
function priceFromTick(
  tick: number,
  decimals0: number,
  decimals1: number
): number {
  return Math.pow(1.0001, tick) * 10 ** (decimals0 - decimals1);
}

/**
 * Snap a tick down (floor) to the nearest multiple of tickSpacing.
 */
function snapTickFloor(tick: number, tickSpacing: number): number {
  return Math.floor(tick / tickSpacing) * tickSpacing;
}

/**
 * Snap a tick up (ceil) to the nearest multiple of tickSpacing.
 */
function snapTickCeil(tick: number, tickSpacing: number): number {
  return Math.ceil(tick / tickSpacing) * tickSpacing;
}

// =========================================================================
// Tool 1: mantle_getV3PoolState
// =========================================================================

export async function getV3PoolState(
  args: Record<string, unknown>
): Promise<unknown> {
  const { network } = normalizeNetwork(args);
  const client = getPublicClient(network);

  let poolAddress: `0x${string}`;
  let provider: V3Provider | null = null;

  // --- Resolve pool address ---
  if (args.pool_address && typeof args.pool_address === "string") {
    poolAddress = requireAddress(args.pool_address, "pool_address");
    if (args.provider && typeof args.provider === "string") {
      const p = args.provider.toLowerCase();
      if (V3_PROVIDERS.has(p as V3Provider)) {
        provider = p as V3Provider;
      }
    }
  } else {
    // Resolve via factory
    const tokenAInput = requireString(args.token_a, "token_a");
    const tokenBInput = requireString(args.token_b, "token_b");
    const feeTier = args.fee_tier;
    if (feeTier == null || typeof feeTier !== "number") {
      throw new MantleMcpError(
        "INVALID_INPUT",
        "fee_tier is required when pool_address is not provided.",
        "Provide fee_tier (e.g. 500, 3000, 10000).",
        { field: "fee_tier" }
      );
    }
    const providerInput = requireString(args.provider, "provider").toLowerCase();
    if (!V3_PROVIDERS.has(providerInput as V3Provider)) {
      throw new MantleMcpError(
        "INVALID_INPUT",
        `provider must be 'agni' or 'fluxion' for V3 pool lookup.`,
        "Use provider='agni' or provider='fluxion'.",
        { provider: providerInput }
      );
    }
    provider = providerInput as V3Provider;

    const [tokenAInfo, tokenBInfo] = await Promise.all([
      resolveTokenInfo(tokenAInput, network),
      resolveTokenInfo(tokenBInput, network)
    ]);

    const factoryAddress = getContractAddress(provider, "factory", network);
    const resolvedPool = await client.readContract({
      address: factoryAddress,
      abi: V3_FACTORY_ABI,
      functionName: "getPool",
      args: [
        tokenAInfo.address as `0x${string}`,
        tokenBInfo.address as `0x${string}`,
        feeTier
      ]
    });

    poolAddress = resolvedPool as `0x${string}`;

    if (
      !poolAddress ||
      poolAddress === "0x0000000000000000000000000000000000000000"
    ) {
      throw new MantleMcpError(
        "POOL_NOT_FOUND",
        `No ${provider} V3 pool found for ${tokenAInput}/${tokenBInput} at fee tier ${feeTier}.`,
        "Verify the token pair and fee tier, or provide a pool_address directly.",
        { token_a: tokenAInput, token_b: tokenBInput, fee_tier: feeTier, provider }
      );
    }
  }

  // --- Multicall: read pool state ---
  const poolCalls = [
    { address: poolAddress, abi: V3_POOL_ABI, functionName: "slot0" as const },
    { address: poolAddress, abi: V3_POOL_ABI, functionName: "liquidity" as const },
    { address: poolAddress, abi: V3_POOL_ABI, functionName: "token0" as const },
    { address: poolAddress, abi: V3_POOL_ABI, functionName: "token1" as const },
    { address: poolAddress, abi: V3_POOL_ABI, functionName: "fee" as const },
    { address: poolAddress, abi: V3_POOL_ABI, functionName: "tickSpacing" as const }
  ];

  const results = await client.multicall({ contracts: poolCalls });

  // Validate all calls succeeded
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "failure") {
      throw new MantleMcpError(
        "RPC_ERROR",
        `Failed to read pool state from ${poolAddress}. The address may not be a valid V3 pool.`,
        "Verify the pool address is a deployed Uniswap V3-compatible pool.",
        { pool_address: poolAddress, failed_call_index: i }
      );
    }
  }

  const slot0 = results[0].result as readonly [bigint, number, number, number, number, number, boolean];
  const poolLiquidity = results[1].result as bigint;
  const token0Addr = results[2].result as `0x${string}`;
  const token1Addr = results[3].result as `0x${string}`;
  const poolFee = results[4].result as number;
  const tickSpacing = results[5].result as number;

  const sqrtPriceX96 = slot0[0];
  const currentTick = slot0[1];

  // Resolve token metadata
  const [token0Info, token1Info] = await Promise.all([
    resolveTokenInfo(token0Addr, network),
    resolveTokenInfo(token1Addr, network)
  ]);

  const decimals0 = token0Info.decimals ?? 18;
  const decimals1 = token1Info.decimals ?? 18;
  const prices = priceFromSqrtX96(sqrtPriceX96, decimals0, decimals1);

  return {
    pool_address: poolAddress,
    provider: provider ?? "unknown",
    token0: {
      address: token0Info.address,
      symbol: token0Info.symbol,
      decimals: token0Info.decimals
    },
    token1: {
      address: token1Info.address,
      symbol: token1Info.symbol,
      decimals: token1Info.decimals
    },
    sqrt_price_x96: sqrtPriceX96.toString(),
    current_tick: currentTick,
    tick_spacing: tickSpacing,
    fee: poolFee,
    pool_liquidity: poolLiquidity.toString(),
    price_token0_per_token1: prices.price_token0_per_token1,
    price_token1_per_token0: prices.price_token1_per_token0,
    queried_at_utc: nowUtc()
  };
}

// =========================================================================
// Tool 2: mantle_getLBPairState
// =========================================================================

export async function getLBPairState(
  args: Record<string, unknown>
): Promise<unknown> {
  const { network } = normalizeNetwork(args);
  const client = getPublicClient(network);

  let pairAddress: `0x${string}`;

  // --- Resolve pair address ---
  if (args.pair_address && typeof args.pair_address === "string") {
    pairAddress = requireAddress(args.pair_address, "pair_address");
  } else {
    const tokenAInput = requireString(args.token_a, "token_a");
    const tokenBInput = requireString(args.token_b, "token_b");
    const binStep = args.bin_step;
    if (binStep == null || typeof binStep !== "number") {
      throw new MantleMcpError(
        "INVALID_INPUT",
        "bin_step is required when pair_address is not provided.",
        "Provide bin_step (e.g. 1, 5, 10, 15, 20, 25).",
        { field: "bin_step" }
      );
    }

    const [tokenAInfo, tokenBInfo] = await Promise.all([
      resolveTokenInfo(tokenAInput, network),
      resolveTokenInfo(tokenBInput, network)
    ]);

    const factoryAddress = getContractAddress(
      "merchant_moe",
      "lb_factory_v2_2",
      network
    );

    const pairInfo = (await client.readContract({
      address: factoryAddress,
      abi: LB_FACTORY_ABI,
      functionName: "getLBPairInformation",
      args: [
        tokenAInfo.address as `0x${string}`,
        tokenBInfo.address as `0x${string}`,
        BigInt(binStep)
      ]
    })) as { binStep: number; LBPair: `0x${string}`; createdByOwner: boolean; ignoredForRouting: boolean };

    pairAddress = pairInfo.LBPair;

    if (
      !pairAddress ||
      pairAddress === "0x0000000000000000000000000000000000000000"
    ) {
      throw new MantleMcpError(
        "POOL_NOT_FOUND",
        `No Merchant Moe LB pair found for ${tokenAInput}/${tokenBInput} at bin step ${binStep}.`,
        "Verify the token pair and bin step, or provide a pair_address directly.",
        { token_a: tokenAInput, token_b: tokenBInput, bin_step: binStep }
      );
    }
  }

  // --- Read core pair state ---
  const coreCalls = [
    { address: pairAddress, abi: LB_PAIR_ABI, functionName: "getActiveId" as const },
    { address: pairAddress, abi: LB_PAIR_ABI, functionName: "getTokenX" as const },
    { address: pairAddress, abi: LB_PAIR_ABI, functionName: "getTokenY" as const },
    { address: pairAddress, abi: LB_PAIR_ABI, functionName: "getBinStep" as const }
  ];

  const coreResults = await client.multicall({ contracts: coreCalls });

  for (let i = 0; i < coreResults.length; i++) {
    if (coreResults[i].status === "failure") {
      throw new MantleMcpError(
        "RPC_ERROR",
        `Failed to read LB pair state from ${pairAddress}. The address may not be a valid LB pair.`,
        "Verify the pair address is a deployed Merchant Moe Liquidity Book pair.",
        { pair_address: pairAddress, failed_call_index: i }
      );
    }
  }

  const activeId = coreResults[0].result as number;
  const tokenXAddr = coreResults[1].result as `0x${string}`;
  const tokenYAddr = coreResults[2].result as `0x${string}`;
  const binStep = coreResults[3].result as number;

  // Resolve token metadata
  const [tokenXInfo, tokenYInfo] = await Promise.all([
    resolveTokenInfo(tokenXAddr, network),
    resolveTokenInfo(tokenYAddr, network)
  ]);

  // --- Read active +-5 bins (11 total) ---
  const BIN_RADIUS = 5;
  const binIds: number[] = [];
  for (let offset = -BIN_RADIUS; offset <= BIN_RADIUS; offset++) {
    const id = activeId + offset;
    if (id >= 0) {
      binIds.push(id);
    }
  }

  const binCalls = binIds.map((id) => ({
    address: pairAddress,
    abi: LB_PAIR_ABI,
    functionName: "getBin" as const,
    args: [id] as const
  }));

  const binResults = await client.multicall({ contracts: binCalls });

  const decimalsX = tokenXInfo.decimals ?? 18;
  const decimalsY = tokenYInfo.decimals ?? 18;

  const nearbyBins = binIds.map((id, i) => {
    const res = binResults[i];
    if (res.status === "failure") {
      return {
        id,
        reserve_x: "0",
        reserve_y: "0",
        reserve_x_decimal: "0",
        reserve_y_decimal: "0",
        is_active: id === activeId
      };
    }
    const [reserveX, reserveY] = res.result as readonly [bigint, bigint];
    return {
      id,
      reserve_x: reserveX.toString(),
      reserve_y: reserveY.toString(),
      reserve_x_decimal: formatUnits(reserveX, decimalsX),
      reserve_y_decimal: formatUnits(reserveY, decimalsY),
      is_active: id === activeId
    };
  });

  // Active bin reserves
  const activeBin = nearbyBins.find((b) => b.is_active);

  return {
    pair_address: pairAddress,
    token_x: {
      address: tokenXInfo.address,
      symbol: tokenXInfo.symbol,
      decimals: tokenXInfo.decimals
    },
    token_y: {
      address: tokenYInfo.address,
      symbol: tokenYInfo.symbol,
      decimals: tokenYInfo.decimals
    },
    active_id: activeId,
    bin_step: binStep,
    active_bin: activeBin
      ? {
          reserve_x: activeBin.reserve_x,
          reserve_y: activeBin.reserve_y,
          reserve_x_decimal: activeBin.reserve_x_decimal,
          reserve_y_decimal: activeBin.reserve_y_decimal
        }
      : null,
    nearby_bins: nearbyBins,
    queried_at_utc: nowUtc()
  };
}

// =========================================================================
// Tool 3: mantle_getV3Positions
// =========================================================================

const MAX_POSITIONS_PER_PROVIDER = 50;

interface PositionResult {
  token_id: string;
  provider: V3Provider;
  token0: TokenInfo;
  token1: TokenInfo;
  fee: number;
  tick_lower: number;
  tick_upper: number;
  liquidity: string;
  tokens_owed0: string;
  tokens_owed1: string;
  in_range: boolean;
}

async function readPositionsForProvider(
  provider: V3Provider,
  owner: `0x${string}`,
  network: Network,
  includeEmpty: boolean
): Promise<PositionResult[]> {
  const client = getPublicClient(network);
  const positionManager = getContractAddress(
    provider,
    "position_manager",
    network
  );

  // Step 1: Get balance (number of NFTs)
  const balance = await client.readContract({
    address: positionManager,
    abi: V3_POSITION_MANAGER_ABI,
    functionName: "balanceOf",
    args: [owner]
  });

  const count = Number(balance);
  if (count === 0) return [];

  const cappedCount = Math.min(count, MAX_POSITIONS_PER_PROVIDER);

  // Step 2: Get all token IDs via multicall
  const indexCalls = Array.from({ length: cappedCount }, (_, i) => ({
    address: positionManager,
    abi: V3_POSITION_MANAGER_ABI,
    functionName: "tokenOfOwnerByIndex" as const,
    args: [owner, BigInt(i)] as const
  }));

  const indexResults = await client.multicall({ contracts: indexCalls });

  const tokenIds: bigint[] = [];
  for (const res of indexResults) {
    if (res.status === "success") {
      tokenIds.push(res.result as bigint);
    }
  }

  if (tokenIds.length === 0) return [];

  // Step 3: Read all positions via multicall
  const positionCalls = tokenIds.map((tokenId) => ({
    address: positionManager,
    abi: V3_POSITION_MANAGER_ABI,
    functionName: "positions" as const,
    args: [tokenId] as const
  }));

  const positionResults = await client.multicall({ contracts: positionCalls });

  // Step 4: Collect unique pools to read slot0 for in_range checks
  const poolKeys = new Map<
    string,
    { token0: `0x${string}`; token1: `0x${string}`; fee: number }
  >();
  const rawPositions: Array<{
    tokenId: bigint;
    token0: `0x${string}`;
    token1: `0x${string}`;
    fee: number;
    tickLower: number;
    tickUpper: number;
    liquidity: bigint;
    tokensOwed0: bigint;
    tokensOwed1: bigint;
  }> = [];

  for (let i = 0; i < positionResults.length; i++) {
    const res = positionResults[i];
    if (res.status !== "success") continue;

    const r = res.result as readonly [
      bigint, string, string, string, number, number, number,
      bigint, bigint, bigint, bigint, bigint
    ];

    const liquidity = r[7];
    const tokensOwed0 = r[10];
    const tokensOwed1 = r[11];

    // Filter zero-liquidity unless include_empty
    if (!includeEmpty && liquidity === 0n && tokensOwed0 === 0n && tokensOwed1 === 0n) {
      continue;
    }

    const token0 = r[2] as `0x${string}`;
    const token1 = r[3] as `0x${string}`;
    const fee = r[4];
    const poolKey = `${token0}-${token1}-${fee}`.toLowerCase();

    poolKeys.set(poolKey, { token0, token1, fee });
    rawPositions.push({
      tokenId: tokenIds[i],
      token0,
      token1,
      fee,
      tickLower: r[5],
      tickUpper: r[6],
      liquidity,
      tokensOwed0,
      tokensOwed1
    });
  }

  if (rawPositions.length === 0) return [];

  // Step 5: Resolve pool addresses and read current ticks
  const factoryAddress = getContractAddress(provider, "factory", network);
  const poolEntries = Array.from(poolKeys.entries());

  const poolLookupCalls = poolEntries.map(([, { token0, token1, fee }]) => ({
    address: factoryAddress,
    abi: V3_FACTORY_ABI,
    functionName: "getPool" as const,
    args: [token0, token1, fee] as const
  }));

  const poolLookupResults = await client.multicall({
    contracts: poolLookupCalls
  });

  const poolAddresses = new Map<string, `0x${string}`>();
  for (let i = 0; i < poolEntries.length; i++) {
    if (poolLookupResults[i].status === "success") {
      const addr = poolLookupResults[i].result as `0x${string}`;
      if (addr !== "0x0000000000000000000000000000000000000000") {
        poolAddresses.set(poolEntries[i][0], addr);
      }
    }
  }

  // Read slot0 for each unique pool
  const uniquePoolAddrs = Array.from(new Set(poolAddresses.values()));
  const slot0Calls = uniquePoolAddrs.map((addr) => ({
    address: addr,
    abi: V3_POOL_ABI,
    functionName: "slot0" as const
  }));

  const slot0Results =
    uniquePoolAddrs.length > 0
      ? await client.multicall({ contracts: slot0Calls })
      : [];

  const poolTicks = new Map<string, number>();
  for (let i = 0; i < uniquePoolAddrs.length; i++) {
    if (slot0Results[i]?.status === "success") {
      const slot0 = slot0Results[i].result as readonly [bigint, number, ...unknown[]];
      poolTicks.set(uniquePoolAddrs[i].toLowerCase(), slot0[1]);
    }
  }

  // Step 6: Resolve token metadata (unique addresses only)
  const uniqueTokenAddrs = new Set<string>();
  for (const pos of rawPositions) {
    uniqueTokenAddrs.add(pos.token0);
    uniqueTokenAddrs.add(pos.token1);
  }
  const tokenEntries = Array.from(uniqueTokenAddrs);
  const tokenInfoResults = await Promise.all(
    tokenEntries.map((addr) => resolveTokenInfo(addr, network))
  );
  const tokenInfoMap = new Map<string, TokenInfo>();
  for (let i = 0; i < tokenEntries.length; i++) {
    tokenInfoMap.set(tokenEntries[i].toLowerCase(), tokenInfoResults[i]);
  }

  // Step 7: Build result
  const positions: PositionResult[] = rawPositions.map((pos) => {
    const poolKey = `${pos.token0}-${pos.token1}-${pos.fee}`.toLowerCase();
    const poolAddr = poolAddresses.get(poolKey);
    const currentTick = poolAddr
      ? poolTicks.get(poolAddr.toLowerCase())
      : undefined;

    const inRange =
      currentTick != null
        ? currentTick >= pos.tickLower && currentTick < pos.tickUpper
        : false;

    const t0 = tokenInfoMap.get(pos.token0.toLowerCase()) ?? {
      address: pos.token0,
      symbol: null,
      decimals: null
    };
    const t1 = tokenInfoMap.get(pos.token1.toLowerCase()) ?? {
      address: pos.token1,
      symbol: null,
      decimals: null
    };

    return {
      token_id: pos.tokenId.toString(),
      provider,
      token0: t0,
      token1: t1,
      fee: pos.fee,
      tick_lower: pos.tickLower,
      tick_upper: pos.tickUpper,
      liquidity: pos.liquidity.toString(),
      tokens_owed0: pos.tokensOwed0.toString(),
      tokens_owed1: pos.tokensOwed1.toString(),
      in_range: inRange
    };
  });

  return positions;
}

export async function getV3Positions(
  args: Record<string, unknown>
): Promise<unknown> {
  const { network } = normalizeNetwork(args);
  const owner = requireAddress(args.owner, "owner");
  const includeEmpty = args.include_empty === true;

  // Determine which providers to scan
  let providers: V3Provider[] = ["agni", "fluxion"];
  if (args.provider && typeof args.provider === "string") {
    const p = args.provider.toLowerCase();
    if (V3_PROVIDERS.has(p as V3Provider)) {
      providers = [p as V3Provider];
    } else {
      throw new MantleMcpError(
        "INVALID_INPUT",
        `provider must be 'agni' or 'fluxion'.`,
        "Use provider='agni', provider='fluxion', or omit to scan both.",
        { provider: args.provider }
      );
    }
  }

  const allPositions: PositionResult[] = [];
  const errors: Array<{ provider: string; error: string }> = [];

  // Scan each provider
  const results = await Promise.allSettled(
    providers.map((p) => readPositionsForProvider(p, owner, network, includeEmpty))
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      allPositions.push(...result.value);
    } else {
      errors.push({
        provider: providers[i],
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
      });
    }
  }

  return {
    owner,
    network,
    total_positions: allPositions.length,
    positions: allPositions,
    errors: errors.length > 0 ? errors : undefined,
    include_empty: includeEmpty,
    queried_at_utc: nowUtc()
  };
}

// =========================================================================
// Tool 4: mantle_suggestTickRange
// =========================================================================

interface TickRangeSuggestion {
  strategy: string;
  description: string;
  tick_lower: number;
  tick_upper: number;
  price_lower: number;
  price_upper: number;
  tick_count: number;
}

export async function suggestTickRange(
  args: Record<string, unknown>
): Promise<unknown> {
  // Reuse getV3PoolState logic to fetch pool state
  const poolState = (await getV3PoolState(args)) as {
    pool_address: string;
    provider: string;
    token0: TokenInfo;
    token1: TokenInfo;
    sqrt_price_x96: string;
    current_tick: number;
    tick_spacing: number;
    fee: number;
    pool_liquidity: string;
    price_token0_per_token1: number;
    price_token1_per_token0: number;
    queried_at_utc: string;
  };

  const currentTick = poolState.current_tick;
  const tickSpacing = poolState.tick_spacing;
  const decimals0 = poolState.token0.decimals ?? 18;
  const decimals1 = poolState.token1.decimals ?? 18;

  const strategies: Array<{
    name: string;
    description: string;
    multiplier: number;
  }> = [
    {
      name: "wide",
      description:
        "Wide range: captures large price moves, lower capital efficiency. Good for volatile pairs or passive LPs.",
      multiplier: 200
    },
    {
      name: "moderate",
      description:
        "Moderate range: balanced capital efficiency vs. rebalance frequency. Good for most pairs.",
      multiplier: 50
    },
    {
      name: "tight",
      description:
        "Tight range: highest capital efficiency, requires frequent rebalancing. Best for stable pairs or active managers.",
      multiplier: 10
    }
  ];

  const suggestions: TickRangeSuggestion[] = strategies.map(
    ({ name, description, multiplier }) => {
      const rawLower = currentTick - multiplier * tickSpacing;
      const rawUpper = currentTick + multiplier * tickSpacing;
      const tickLower = snapTickFloor(rawLower, tickSpacing);
      const tickUpper = snapTickCeil(rawUpper, tickSpacing);
      const priceLower = priceFromTick(tickLower, decimals0, decimals1);
      const priceUpper = priceFromTick(tickUpper, decimals0, decimals1);
      const tickCount = (tickUpper - tickLower) / tickSpacing;

      return {
        strategy: name,
        description,
        tick_lower: tickLower,
        tick_upper: tickUpper,
        price_lower: priceLower,
        price_upper: priceUpper,
        tick_count: tickCount
      };
    }
  );

  return {
    pool_address: poolState.pool_address,
    provider: poolState.provider,
    token0: poolState.token0,
    token1: poolState.token1,
    fee: poolState.fee,
    current_tick: currentTick,
    tick_spacing: tickSpacing,
    current_price_token1_per_token0: poolState.price_token1_per_token0,
    current_price_token0_per_token1: poolState.price_token0_per_token1,
    suggestions,
    note: "Prices shown as token1 per token0 (the standard V3 convention). price_lower/price_upper correspond to tick_lower/tick_upper respectively.",
    queried_at_utc: nowUtc()
  };
}

// =========================================================================
// Tool 5: mantle_analyzePool
// =========================================================================

const DEXSCREENER_API_BASE = "https://api.dexscreener.com";

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

function resolveDexScreenerChain(network: Network): string | null {
  return network === "mainnet" ? "mantle" : null;
}

interface DexScreenerPairData {
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number | string | null };
  volume?: { h24?: number | string | null };
  priceChange?: { h24?: number | string | null; h6?: number | string | null };
  fdv?: number | null;
}

async function fetchDexScreenerPoolData(
  network: Network,
  poolAddress: string
): Promise<DexScreenerPairData | null> {
  const chainId = resolveDexScreenerChain(network);
  if (!chainId) return null;

  const payload = await fetchJsonSafe(
    `${DEXSCREENER_API_BASE}/latest/dex/pairs/${chainId}/${poolAddress}`
  );
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.pairs)) {
    return null;
  }
  const pairs = payload.pairs as DexScreenerPairData[];
  return (
    pairs.find(
      (p) =>
        p.pairAddress &&
        p.pairAddress.toLowerCase() === poolAddress.toLowerCase()
    ) ??
    pairs[0] ??
    null
  );
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

interface RangeAnalysis {
  label: string;
  range_pct: number;
  tick_lower: number;
  tick_upper: number;
  price_lower: number;
  price_upper: number;
  concentration_factor: number;
  fee_apr_pct: number;
  total_apr_pct: number;
  daily_fee_usd: number | null;
  weekly_fee_usd: number | null;
  monthly_fee_usd: number | null;
  rebalance_risk: "low" | "medium" | "high";
}

interface RiskAssessment {
  overall: "low" | "medium" | "high";
  tvl_risk: "low" | "medium" | "high";
  volatility_risk: "low" | "medium" | "high";
  concentration_risk: "low" | "medium" | "high";
  details: string[];
}

export async function analyzePool(
  args: Record<string, unknown>
): Promise<unknown> {
  // Read pool state
  const poolState = (await getV3PoolState(args)) as {
    pool_address: string;
    provider: string;
    token0: TokenInfo;
    token1: TokenInfo;
    sqrt_price_x96: string;
    current_tick: number;
    tick_spacing: number;
    fee: number;
    pool_liquidity: string;
    price_token0_per_token1: number;
    price_token1_per_token0: number;
    queried_at_utc: string;
  };

  const { network } = normalizeNetwork(args);
  const investmentUsd = typeof args.investment_usd === "number" ? args.investment_usd : 1000;

  const currentTick = poolState.current_tick;
  const tickSpacing = poolState.tick_spacing;
  const decimals0 = poolState.token0.decimals ?? 18;
  const decimals1 = poolState.token1.decimals ?? 18;
  const feeRate = poolState.fee / 1_000_000; // e.g. 3000 → 0.003

  // Fetch pool market data from DexScreener
  const pairData = await fetchDexScreenerPoolData(network, poolState.pool_address);

  const liquidityUsd = asFiniteNumber(pairData?.liquidity?.usd) ?? null;
  const volume24hUsd = asFiniteNumber(pairData?.volume?.h24) ?? null;
  const priceChange24h = asFiniteNumber(pairData?.priceChange?.h24) ?? null;
  const priceChange6h = asFiniteNumber(pairData?.priceChange?.h6) ?? null;

  // Base fee APR = (24h volume × fee rate × 365) / TVL
  const baseFeeApr =
    volume24hUsd != null && liquidityUsd != null && liquidityUsd > 0
      ? (volume24hUsd * feeRate * 365) / liquidityUsd
      : null;

  // Define range brackets (percentage around current price)
  const RANGE_BRACKETS = [
    { label: "±1%", pct: 1 },
    { label: "±2%", pct: 2 },
    { label: "±3%", pct: 3 },
    { label: "±5%", pct: 5 },
    { label: "±8%", pct: 8 },
    { label: "±10%", pct: 10 },
    { label: "±15%", pct: 15 },
    { label: "±20%", pct: 20 },
    { label: "±35%", pct: 35 },
    { label: "±50%", pct: 50 }
  ];

  // Full range tick span (approximately MIN_TICK to MAX_TICK)
  const FULL_RANGE_TICKS = 887220 * 2;

  const ranges: RangeAnalysis[] = RANGE_BRACKETS.map((bracket) => {
    // Convert percentage to tick offset
    // price = 1.0001^tick, so for ±X%:
    // tickOffset = log(1+X/100) / log(1.0001)
    const tickOffsetUp = Math.floor(
      Math.log(1 + bracket.pct / 100) / Math.log(1.0001)
    );
    const tickOffsetDown = Math.floor(
      Math.log(1 - bracket.pct / 100) / Math.log(1.0001)
    );

    const rawLower = currentTick + tickOffsetDown;
    const rawUpper = currentTick + tickOffsetUp;
    const tickLower = snapTickFloor(rawLower, tickSpacing);
    const tickUpper = snapTickCeil(rawUpper, tickSpacing);

    const priceLower = priceFromTick(tickLower, decimals0, decimals1);
    const priceUpper = priceFromTick(tickUpper, decimals0, decimals1);

    const rangeTickSpan = tickUpper - tickLower;
    const concentrationFactor =
      rangeTickSpan > 0 ? FULL_RANGE_TICKS / rangeTickSpan : 1;

    // Concentrated fee APR = baseFeeApr × concentrationFactor
    const feeAprPct =
      baseFeeApr != null ? baseFeeApr * 100 * concentrationFactor : 0;

    // Total APR (fee only for now — no farming rewards)
    const totalAprPct = feeAprPct;

    // Investment projections
    const dailyFee =
      volume24hUsd != null && liquidityUsd != null && liquidityUsd > 0
        ? (volume24hUsd * feeRate * concentrationFactor * investmentUsd) /
          liquidityUsd
        : null;
    const weeklyFee = dailyFee != null ? dailyFee * 7 : null;
    const monthlyFee = dailyFee != null ? dailyFee * 30 : null;

    // Rebalance risk based on range width vs 24h volatility
    let rebalanceRisk: "low" | "medium" | "high" = "low";
    if (priceChange24h != null) {
      const absChange = Math.abs(priceChange24h);
      if (absChange > bracket.pct * 0.8) {
        rebalanceRisk = "high";
      } else if (absChange > bracket.pct * 0.4) {
        rebalanceRisk = "medium";
      }
    }

    return {
      label: bracket.label,
      range_pct: bracket.pct,
      tick_lower: tickLower,
      tick_upper: tickUpper,
      price_lower: priceLower,
      price_upper: priceUpper,
      concentration_factor: Math.round(concentrationFactor * 100) / 100,
      fee_apr_pct: Math.round(feeAprPct * 100) / 100,
      total_apr_pct: Math.round(totalAprPct * 100) / 100,
      daily_fee_usd: dailyFee != null ? Math.round(dailyFee * 100) / 100 : null,
      weekly_fee_usd: weeklyFee != null ? Math.round(weeklyFee * 100) / 100 : null,
      monthly_fee_usd: monthlyFee != null ? Math.round(monthlyFee * 100) / 100 : null,
      rebalance_risk: rebalanceRisk
    };
  });

  // Risk assessment
  const riskDetails: string[] = [];
  let tvlRisk: "low" | "medium" | "high" = "low";
  if (liquidityUsd == null) {
    tvlRisk = "high";
    riskDetails.push("TVL data unavailable — cannot assess liquidity depth.");
  } else if (liquidityUsd < 100_000) {
    tvlRisk = "high";
    riskDetails.push(
      `Low TVL ($${liquidityUsd.toLocaleString()}) — high slippage and impermanent loss risk.`
    );
  } else if (liquidityUsd < 500_000) {
    tvlRisk = "medium";
    riskDetails.push(
      `Moderate TVL ($${liquidityUsd.toLocaleString()}) — adequate for small to medium positions.`
    );
  } else {
    riskDetails.push(
      `Healthy TVL ($${liquidityUsd.toLocaleString()}).`
    );
  }

  let volatilityRisk: "low" | "medium" | "high" = "low";
  if (priceChange24h != null) {
    const absChange = Math.abs(priceChange24h);
    if (absChange > 15) {
      volatilityRisk = "high";
      riskDetails.push(
        `High 24h volatility (${priceChange24h > 0 ? "+" : ""}${priceChange24h.toFixed(1)}%) — frequent rebalancing needed for tight ranges.`
      );
    } else if (absChange > 5) {
      volatilityRisk = "medium";
      riskDetails.push(
        `Moderate 24h volatility (${priceChange24h > 0 ? "+" : ""}${priceChange24h.toFixed(1)}%) — moderate ranges recommended.`
      );
    } else {
      riskDetails.push(
        `Low 24h volatility (${priceChange24h > 0 ? "+" : ""}${priceChange24h.toFixed(1)}%) — tight ranges feasible.`
      );
    }
  } else {
    volatilityRisk = "medium";
    riskDetails.push("Price change data unavailable — volatility risk unknown.");
  }

  let concentrationRisk: "low" | "medium" | "high" = "low";
  const poolLiqBigInt = BigInt(poolState.pool_liquidity);
  if (poolLiqBigInt === 0n) {
    concentrationRisk = "high";
    riskDetails.push("Pool has zero liquidity — may be inactive or newly created.");
  }

  const riskScores = { low: 0, medium: 1, high: 2 } as const;
  const maxRisk = Math.max(
    riskScores[tvlRisk],
    riskScores[volatilityRisk],
    riskScores[concentrationRisk]
  );
  const overallRisk: "low" | "medium" | "high" =
    maxRisk >= 2 ? "high" : maxRisk === 1 ? "medium" : "low";

  const risk: RiskAssessment = {
    overall: overallRisk,
    tvl_risk: tvlRisk,
    volatility_risk: volatilityRisk,
    concentration_risk: concentrationRisk,
    details: riskDetails
  };

  // Find recommended range
  let recommendedRange: string | null = null;
  if (priceChange24h != null) {
    const absChange = Math.abs(priceChange24h);
    // Recommend a range that is about 3x the daily volatility
    const targetPct = Math.max(absChange * 3, 3);
    const bestRange = ranges.reduce((prev, curr) =>
      Math.abs(curr.range_pct - targetPct) < Math.abs(prev.range_pct - targetPct)
        ? curr
        : prev
    );
    recommendedRange = bestRange.label;
  }

  return {
    pool_address: poolState.pool_address,
    provider: poolState.provider,
    token0: poolState.token0,
    token1: poolState.token1,
    fee: poolState.fee,
    fee_rate_pct: feeRate * 100,
    current_tick: currentTick,
    tick_spacing: tickSpacing,
    current_price_token1_per_token0: poolState.price_token1_per_token0,
    current_price_token0_per_token1: poolState.price_token0_per_token1,

    // Market data
    market_data: {
      tvl_usd: liquidityUsd,
      volume_24h_usd: volume24hUsd,
      price_change_24h_pct: priceChange24h,
      price_change_6h_pct: priceChange6h,
      base_fee_apr_pct:
        baseFeeApr != null ? Math.round(baseFeeApr * 100 * 100) / 100 : null
    },

    // Multi-range analysis
    ranges,
    recommended_range: recommendedRange,

    // Investment projection
    investment: {
      amount_usd: investmentUsd,
      note: "Projections assume constant volume and price. Actual returns depend on price movement, rebalancing costs, and impermanent loss."
    },

    // Risk assessment
    risk,

    queried_at_utc: nowUtc()
  };
}

// =========================================================================
// Tool 6: mantle_findPools
// =========================================================================

/**
 * Common V3 fee tiers to scan (in hundredths of bip).
 * 100=0.01%, 500=0.05%, 3000=0.3%, 10000=1%
 */
const V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

/**
 * Common LB bin steps to scan.
 * 1=stablecoins, 2, 5=LSTs, 10, 15, 20=volatile, 25
 */
const LB_BIN_STEPS = [1, 2, 5, 10, 15, 20, 25] as const;

const POOL_LIQUIDITY_ABI = [
  {
    type: "function" as const,
    name: "liquidity" as const,
    stateMutability: "view" as const,
    inputs: [],
    outputs: [{ name: "", type: "uint128" as const }]
  }
] as const;

interface FoundPool {
  provider: string;
  pool_address: string;
  fee_tier?: number;
  bin_step?: number;
  liquidity_raw: string;
  has_liquidity: boolean;
}

async function findPools(
  args: Record<string, unknown>
): Promise<unknown> {
  const { network } = normalizeNetwork(args);
  const client = getPublicClient(network);

  const tokenAInput = requireString(args.token_a, "token_a");
  const tokenBInput = requireString(args.token_b, "token_b");
  const tokenA = await resolveTokenInfo(tokenAInput, network);
  const tokenB = await resolveTokenInfo(tokenBInput, network);
  const addrA = tokenA.address as `0x${string}`;
  const addrB = tokenB.address as `0x${string}`;

  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  const pools: FoundPool[] = [];

  // --- V3 DEXes: Agni + Fluxion ---
  for (const provider of ["agni", "fluxion"] as const) {
    let factoryAddress: `0x${string}`;
    try {
      factoryAddress = getContractAddress(provider, "factory", network);
    } catch {
      continue; // factory not configured for this provider
    }

    const factoryCalls = V3_FEE_TIERS.map((fee) => ({
      address: factoryAddress,
      abi: V3_FACTORY_ABI,
      functionName: "getPool" as const,
      args: [addrA, addrB, fee] as const
    }));

    const factoryResults = await client.multicall({ contracts: factoryCalls });

    // For pools that exist, read liquidity
    const liquidityCalls: Array<{
      fee: number;
      poolAddress: `0x${string}`;
    }> = [];

    for (let i = 0; i < V3_FEE_TIERS.length; i++) {
      const result = factoryResults[i];
      if (result.status === "success" && result.result && result.result !== ZERO_ADDR) {
        liquidityCalls.push({
          fee: V3_FEE_TIERS[i],
          poolAddress: result.result as `0x${string}`
        });
      }
    }

    if (liquidityCalls.length > 0) {
      const liqResults = await client.multicall({
        contracts: liquidityCalls.map((c) => ({
          address: c.poolAddress,
          abi: POOL_LIQUIDITY_ABI,
          functionName: "liquidity" as const
        }))
      });

      for (let i = 0; i < liquidityCalls.length; i++) {
        const liqResult = liqResults[i];
        const liquidity = liqResult.status === "success" ? (liqResult.result as bigint) : 0n;
        pools.push({
          provider,
          pool_address: liquidityCalls[i].poolAddress,
          fee_tier: liquidityCalls[i].fee,
          liquidity_raw: liquidity.toString(),
          has_liquidity: liquidity > 0n
        });
      }
    }
  }

  // --- Merchant Moe LB ---
  let moeFactory: `0x${string}`;
  try {
    moeFactory = getContractAddress("merchant_moe", "lb_factory_v2_2", network);
  } catch {
    moeFactory = "0x0000000000000000000000000000000000000000" as `0x${string}`;
  }

  if (moeFactory !== ZERO_ADDR) {
    const moeCalls = LB_BIN_STEPS.map((bs) => ({
      address: moeFactory,
      abi: LB_FACTORY_ABI,
      functionName: "getLBPairInformation" as const,
      args: [addrA, addrB, BigInt(bs)] as const
    }));

    const moeResults = await client.multicall({ contracts: moeCalls });

    for (let i = 0; i < LB_BIN_STEPS.length; i++) {
      const result = moeResults[i];
      if (result.status === "success" && result.result) {
        const info = result.result as { binStep: number; LBPair: string; createdByOwner: boolean; ignoredForRouting: boolean };
        if (info.LBPair && info.LBPair !== ZERO_ADDR) {
          // Read active bin to confirm the pair is live
          let hasLiquidity = false;
          try {
            const activeId = await client.readContract({
              address: info.LBPair as `0x${string}`,
              abi: LB_PAIR_ABI,
              functionName: "getActiveId"
            });
            hasLiquidity = typeof activeId === "number" && activeId > 0;
          } catch {
            hasLiquidity = false;
          }

          pools.push({
            provider: "merchant_moe",
            pool_address: info.LBPair,
            bin_step: LB_BIN_STEPS[i],
            liquidity_raw: "0", // LB pairs don't have a single liquidity number
            has_liquidity: hasLiquidity
          });
        }
      }
    }
  }

  // Sort: pools with liquidity first, then by provider
  pools.sort((a, b) => {
    if (a.has_liquidity && !b.has_liquidity) return -1;
    if (!a.has_liquidity && b.has_liquidity) return 1;
    return a.provider.localeCompare(b.provider);
  });

  return {
    token_a: {
      address: tokenA.address,
      symbol: tokenA.symbol,
      decimals: tokenA.decimals
    },
    token_b: {
      address: tokenB.address,
      symbol: tokenB.symbol,
      decimals: tokenB.decimals
    },
    pools,
    total_found: pools.length,
    with_liquidity: pools.filter((p) => p.has_liquidity).length,
    scanned: {
      v3_providers: ["agni", "fluxion"],
      v3_fee_tiers: [...V3_FEE_TIERS],
      lb_bin_steps: [...LB_BIN_STEPS]
    },
    queried_at_utc: nowUtc()
  };
}

// =========================================================================
// Tool 7: mantle_getLBPositions
// =========================================================================

/**
 * Scan a wallet's Merchant Moe Liquidity Book LP positions.
 *
 * Strategy: iterate all known Moe LB pairs from the dex-pairs registry,
 * read the active bin and surrounding bins, then check balanceOf for each
 * bin to find positions the user holds.
 *
 * LIMITATION: This is a heuristic scan around the current active price,
 * not a full enumeration. Positions far from the active price will be missed.
 */

export interface LBPositionDeps {
  getClient: (network: "mainnet" | "sepolia") => any;
  listMoePairs: () => MoePair[];
  resolveToken: (identifier: string, network: Network) => Promise<TokenInfo>;
  now: () => string;
}

const defaultLBDeps: LBPositionDeps = {
  getClient: getPublicClient,
  listMoePairs: () => listPairs("merchant_moe") as MoePair[],
  resolveToken: resolveTokenInfo,
  now: nowUtc
};

function withLBDeps(overrides?: Partial<LBPositionDeps>): LBPositionDeps {
  return { ...defaultLBDeps, ...overrides };
}

export async function getLBPositions(
  args: Record<string, unknown>,
  deps?: Partial<LBPositionDeps>
): Promise<unknown> {
  const resolvedDeps = withLBDeps(deps);
  const { network } = normalizeNetwork(args);
  const owner = requireAddress(args.owner, "owner");
  const client = resolvedDeps.getClient(network);

  // Get all known Moe LB pairs
  const moePairs = resolvedDeps.listMoePairs();

  if (moePairs.length === 0) {
    return {
      owner,
      network,
      total_positions: 0,
      positions: [],
      coverage: "known_pairs_only",
      note: "No known Merchant Moe LB pairs configured for this network.",
      queried_at_utc: resolvedDeps.now()
    };
  }

  // For each known pair, check the active bin +-25 range for user balances
  const BIN_SCAN_RADIUS = 25;

  interface LBPositionBin {
    bin_id: number;
    balance_raw: string;
    share_pct: number | null;
    reserve_x_raw: string;
    reserve_y_raw: string;
    user_amount_x_raw: string | null;
    user_amount_x: string | null;
    user_amount_y_raw: string | null;
    user_amount_y: string | null;
  }

  interface LBPosition {
    pair_address: string;
    token_x: TokenInfo;
    token_y: TokenInfo;
    bin_step: number;
    bins: LBPositionBin[];
    total_bins_with_liquidity: number;
  }

  const allPositions: LBPosition[] = [];
  const errors: Array<{ pair: string; error: string }> = [];

  const pairResults = await Promise.allSettled(
    moePairs.map(async (pair) => {
      const pairAddr = pair.pool as `0x${string}`;

      // Read active bin ID and on-chain token ordering via multicall (F-03/F-08)
      const initCalls = [
        { address: pairAddr, abi: LB_PAIR_ABI, functionName: "getActiveId" as const },
        { address: pairAddr, abi: LB_PAIR_ABI, functionName: "getTokenX" as const },
        { address: pairAddr, abi: LB_PAIR_ABI, functionName: "getTokenY" as const }
      ];
      const initResults = await client.multicall({ contracts: initCalls });

      // Check all 3 calls succeeded
      for (let j = 0; j < initResults.length; j++) {
        if (initResults[j].status !== "success") {
          throw new Error(
            `Failed to read LB pair state from ${pairAddr} (call ${j}). ` +
            "The address may not be a valid LB pair."
          );
        }
      }

      const activeId = initResults[0].result as number;
      const tokenXAddr = initResults[1].result as `0x${string}`;
      const tokenYAddr = initResults[2].result as `0x${string}`;

      // Generate bin IDs to scan
      const binIds: number[] = [];
      for (let offset = -BIN_SCAN_RADIUS; offset <= BIN_SCAN_RADIUS; offset++) {
        const binId = activeId + offset;
        if (binId >= 0) binIds.push(binId);
      }

      // Batch read: user balanceOf + totalSupply + getBin for each bin
      // Use consistent BigInt for all bin ID args (F-15)
      const calls = binIds.flatMap((id) => [
        {
          address: pairAddr,
          abi: LB_PAIR_ABI,
          functionName: "balanceOf" as const,
          args: [owner, BigInt(id)]
        },
        {
          address: pairAddr,
          abi: LB_PAIR_ABI,
          functionName: "totalSupply" as const,
          args: [BigInt(id)]
        },
        {
          address: pairAddr,
          abi: LB_PAIR_ABI,
          functionName: "getBin" as const,
          args: [BigInt(id)]
        }
      ]);

      const results = await client.multicall({ contracts: calls });

      // Resolve token metadata early so we have decimals for formatting (F-14)
      const [tokenXInfo, tokenYInfo] = await Promise.all([
        resolvedDeps.resolveToken(tokenXAddr, network),
        resolvedDeps.resolveToken(tokenYAddr, network)
      ]);

      const decimalsX = tokenXInfo.decimals ?? 18;
      const decimalsY = tokenYInfo.decimals ?? 18;

      // Parse results — 3 calls per bin
      const userBins: LBPositionBin[] = [];
      for (let i = 0; i < binIds.length; i++) {
        const balResult = results[i * 3];
        const supplyResult = results[i * 3 + 1];
        const binResult = results[i * 3 + 2];

        if (balResult.status !== "success") continue;

        const userBalance = balResult.result as bigint;
        if (userBalance === 0n) continue;

        const totalSupply =
          supplyResult.status === "success"
            ? (supplyResult.result as bigint)
            : 0n;

        let reserveX = 0n;
        let reserveY = 0n;
        if (binResult.status === "success") {
          const bin = binResult.result as [bigint, bigint];
          reserveX = bin[0];
          reserveY = bin[1];
        }

        const sharePct =
          totalSupply > 0n
            ? Number((userBalance * 10000n) / totalSupply) / 100
            : null;

        const userAmountXRaw =
          totalSupply > 0n
            ? (reserveX * userBalance) / totalSupply
            : null;
        const userAmountYRaw =
          totalSupply > 0n
            ? (reserveY * userBalance) / totalSupply
            : null;

        userBins.push({
          bin_id: binIds[i],
          balance_raw: userBalance.toString(),
          share_pct: sharePct,
          reserve_x_raw: reserveX.toString(),
          reserve_y_raw: reserveY.toString(),
          user_amount_x_raw: userAmountXRaw?.toString() ?? null,
          user_amount_x: userAmountXRaw != null ? formatUnits(userAmountXRaw, decimalsX) : null,
          user_amount_y_raw: userAmountYRaw?.toString() ?? null,
          user_amount_y: userAmountYRaw != null ? formatUnits(userAmountYRaw, decimalsY) : null
        });
      }

      if (userBins.length === 0) return null;

      return {
        pair_address: pair.pool,
        token_x: tokenXInfo,
        token_y: tokenYInfo,
        bin_step: pair.binStep,
        bins: userBins,
        total_bins_with_liquidity: userBins.length
      } satisfies LBPosition;
    })
  );

  for (let i = 0; i < pairResults.length; i++) {
    const result = pairResults[i];
    if (result.status === "fulfilled" && result.value !== null) {
      allPositions.push(result.value);
    } else if (result.status === "rejected") {
      errors.push({
        pair: moePairs[i].pool,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
      });
    }
  }

  return {
    owner,
    network,
    total_positions: allPositions.length,
    positions: allPositions,
    errors: errors.length > 0 ? errors : undefined,
    coverage: "known_pairs_only",
    scan_radius: BIN_SCAN_RADIUS,
    pairs_scanned: moePairs.length,
    note: allPositions.length === 0
      ? "No LB positions found within +-25 bins of active price on known registry pairs. " +
        "This is a heuristic scan — positions in distant bins or unlisted pairs are NOT checked. " +
        "The wallet may still hold LB positions outside this scan range."
      : "Heuristic scan: only checks +-25 bins around active price on known registry pairs. " +
        "Positions in distant bins or unlisted pairs may be missed.",
    queried_at_utc: resolvedDeps.now()
  };
}

// =========================================================================
// Exported tool record
// =========================================================================

export const defiLpReadTools: Record<string, Tool> = {
  mantle_getV3PoolState: {
    name: "mantle_getV3PoolState",
    description:
      "Read on-chain state of a Uniswap V3-compatible pool (Agni Finance or Fluxion) on Mantle. Returns sqrtPriceX96, current tick, tick spacing, liquidity, and human-readable prices.\n\nResolve by pool_address directly, or by (token_a + token_b + fee_tier + provider) to look up via the factory.\n\nExamples:\n- By address: pool_address='<pool_address>'\n- By pair: token_a='WMNT', token_b='USDC', fee_tier=3000, provider='agni'",
    inputSchema: {
      type: "object",
      properties: {
        pool_address: {
          type: "string",
          description:
            "V3 pool contract address. If provided, token_a/token_b/fee_tier/provider are optional."
        },
        token_a: {
          type: "string",
          description:
            "First token symbol or address. Required if pool_address is not given."
        },
        token_b: {
          type: "string",
          description:
            "Second token symbol or address. Required if pool_address is not given."
        },
        fee_tier: {
          type: "number",
          description:
            "V3 fee tier in hundredths of a bip (500=0.05%, 3000=0.3%, 10000=1%). Required if pool_address is not given."
        },
        provider: {
          type: "string",
          description:
            "DEX provider: 'agni' or 'fluxion'. Required if pool_address is not given; optional hint when pool_address is given."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: []
    },
    handler: getV3PoolState
  },

  mantle_getLBPairState: {
    name: "mantle_getLBPairState",
    description:
      "Read on-chain state of a Merchant Moe Liquidity Book pair on Mantle. Returns active bin ID, bin step, token metadata, active bin reserves, and reserves for +-5 nearby bins.\n\nResolve by pair_address directly, or by (token_a + token_b + bin_step) to look up via the LB Factory.\n\nExamples:\n- By address: pair_address='<pair_address>'\n- By pair: token_a='WMNT', token_b='USDC', bin_step=20",
    inputSchema: {
      type: "object",
      properties: {
        pair_address: {
          type: "string",
          description:
            "LB pair contract address. If provided, token_a/token_b/bin_step are optional."
        },
        token_a: {
          type: "string",
          description:
            "First token symbol or address. Required if pair_address is not given."
        },
        token_b: {
          type: "string",
          description:
            "Second token symbol or address. Required if pair_address is not given."
        },
        bin_step: {
          type: "number",
          description:
            "LB bin step (e.g. 1, 5, 10, 15, 20, 25). Required if pair_address is not given."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: []
    },
    handler: getLBPairState
  },

  mantle_getV3Positions: {
    name: "mantle_getV3Positions",
    description:
      "Enumerate all V3 LP positions for a wallet across Agni Finance and Fluxion on Mantle. Returns token IDs, tick ranges, liquidity, uncollected fees, and whether each position is in-range.\n\nBy default filters out zero-liquidity, zero-fees positions (set include_empty=true to show all).\n\nExamples:\n- All positions: owner='<wallet_address>'\n- Agni only: owner='<wallet_address>', provider='agni'\n- Include empty: owner='<wallet_address>', include_empty=true",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Wallet address to enumerate LP positions for."
        },
        provider: {
          type: "string",
          description:
            "Optional filter: 'agni' or 'fluxion'. Omit to scan both."
        },
        include_empty: {
          type: "boolean",
          description:
            "Include zero-liquidity and zero-fees positions (default: false)."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["owner"]
    },
    handler: getV3Positions
  },

  mantle_suggestTickRange: {
    name: "mantle_suggestTickRange",
    description:
      "Suggest tick ranges for a V3 LP position on Mantle (Agni or Fluxion). Reads current pool state and generates three strategies (wide/moderate/tight) with tick bounds snapped to the pool's tick spacing grid and corresponding prices.\n\nAccepts the same inputs as mantle_getV3PoolState: pool_address OR (token_a + token_b + fee_tier + provider).\n\nExamples:\n- By address: pool_address='<pool_address>'\n- By pair: token_a='WMNT', token_b='USDC', fee_tier=3000, provider='agni'",
    inputSchema: {
      type: "object",
      properties: {
        pool_address: {
          type: "string",
          description:
            "V3 pool contract address. If provided, token_a/token_b/fee_tier/provider are optional."
        },
        token_a: {
          type: "string",
          description:
            "First token symbol or address. Required if pool_address is not given."
        },
        token_b: {
          type: "string",
          description:
            "Second token symbol or address. Required if pool_address is not given."
        },
        fee_tier: {
          type: "number",
          description:
            "V3 fee tier (500, 3000, 10000). Required if pool_address is not given."
        },
        provider: {
          type: "string",
          description:
            "DEX provider: 'agni' or 'fluxion'. Required if pool_address is not given."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: []
    },
    handler: suggestTickRange
  },

  mantle_analyzePool: {
    name: "mantle_analyzePool",
    description:
      "[ANALYZE] Deep analysis of a V3 pool on Mantle (Agni or Fluxion). Returns:\n" +
      "- Fee APR based on 24h volume / TVL\n" +
      "- Multi-range APR comparison (10 brackets from ±1% to ±50%)\n" +
      "- Risk assessment (TVL risk, volatility risk, concentration risk)\n" +
      "- Investment return projections (daily/weekly/monthly fees for a given USD amount)\n" +
      "- Recommended range based on recent volatility\n\n" +
      "Accepts the same inputs as mantle_getV3PoolState: pool_address OR (token_a + token_b + fee_tier + provider).\n" +
      "Optionally pass investment_usd (default: 1000) to see projected returns.\n\n" +
      "Examples:\n" +
      "- Analyze WMNT/USDC on Agni: token_a='WMNT', token_b='USDC', fee_tier=3000, provider='agni'\n" +
      "- With investment amount: pool_address='<pool_address>', investment_usd=5000",
    inputSchema: {
      type: "object",
      properties: {
        pool_address: {
          type: "string",
          description:
            "V3 pool contract address. If provided, token_a/token_b/fee_tier/provider are optional."
        },
        token_a: {
          type: "string",
          description:
            "First token symbol or address. Required if pool_address is not given."
        },
        token_b: {
          type: "string",
          description:
            "Second token symbol or address. Required if pool_address is not given."
        },
        fee_tier: {
          type: "number",
          description:
            "V3 fee tier (500, 3000, 10000). Required if pool_address is not given."
        },
        provider: {
          type: "string",
          description:
            "DEX provider: 'agni' or 'fluxion'. Required if pool_address is not given."
        },
        investment_usd: {
          type: "number",
          description:
            "USD amount to project returns for (default: 1000). Used to calculate daily/weekly/monthly fee income."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: []
    },
    handler: analyzePool
  },

  mantle_findPools: {
    name: "mantle_findPools",
    description:
      "Discover all available liquidity pools for a token pair across ALL Mantle DEXes (Agni, Fluxion, Merchant Moe) by querying factory contracts on-chain. Returns every pool with its fee tier/bin step and whether it has liquidity.\n\nThis is the authoritative pool discovery tool — it queries factory contracts directly, not external indexers. Use it BEFORE adding LP to find the best pool.\n\nScans:\n- Agni & Fluxion: fee tiers 100 (0.01%), 500 (0.05%), 3000 (0.3%), 10000 (1%)\n- Merchant Moe: bin steps 1, 2, 5, 10, 15, 20, 25\n\nExamples:\n- Find USDC/USDe pools: token_a='USDC', token_b='USDe'\n- Find WMNT/USDC pools: token_a='WMNT', token_b='USDC'",
    inputSchema: {
      type: "object",
      properties: {
        token_a: {
          type: "string",
          description: "First token symbol or address."
        },
        token_b: {
          type: "string",
          description: "Second token symbol or address."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["token_a", "token_b"]
    },
    handler: findPools
  },

  mantle_getLBPositions: {
    name: "mantle_getLBPositions",
    description:
      "Scan a wallet's Merchant Moe Liquidity Book LP positions on Mantle. " +
      "Checks all known LB pairs and reads bin balances around the active bin " +
      "(+-25 bins) to find user-held liquidity.\n\n" +
      "COVERAGE NOTE: This is a heuristic scan around the current active price, " +
      "not a full enumeration. Positions minted in bins far from the active price " +
      "(more than 25 bins away) will not be detected. Coverage is limited to " +
      "known pairs in the registry.\n\n" +
      "Returns per-pair breakdown with bin IDs, user share percentage, and " +
      "estimated token amounts (tokenX/tokenY) based on pro-rata share of bin reserves.\n\n" +
      "Use this tool for:\n" +
      "- Approximate portfolio valuation of Merchant Moe LB LP positions\n" +
      "- Understanding near-price liquidity distribution\n" +
      "- Pre-removal checks (which nearby bins hold your liquidity)\n\n" +
      "Examples:\n" +
      "- All LB positions: owner='<wallet_address>'\n" +
      "- Specific network: owner='<wallet_address>', network='mainnet'",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Wallet address to enumerate LB positions for."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["owner"]
    },
    handler: getLBPositions
  }
};
