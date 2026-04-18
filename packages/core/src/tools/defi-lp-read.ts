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
import { listPairs, listAllPairs, TOKENS as DEX_TOKENS, type MoePair, type V3Pair, type DexPair } from "../config/dex-pairs.js";
import { MANTLE_TOKENS } from "../config/tokens.js";
import dexscreenerPoolsSnapshot from "../config/dexscreener-pools.json" with { type: "json" };

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
  if (sqrtPriceX96 === 0n) {
    throw new MantleMcpError(
      "POOL_UNINITIALIZED",
      "Pool sqrtPriceX96 is 0 — pool is not initialized.",
      "Use a different pool or wait for it to be initialized."
    );
  }
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

/**
 * Discover token IDs owned by `owner` when ERC721Enumerable is unavailable.
 *
 * Strategy: query Transfer event logs where `to = owner`, deduplicate, then
 * batch-verify current ownership via ownerOf. This handles tokens that were
 * received and later transferred away.
 *
 * Many RPCs limit the block range for eth_getLogs (Mantle's public RPC
 * commonly caps at ~100k blocks). We use a chunked approach, scanning
 * backward from the chain tip to find events efficiently. Failures on a
 * given chunk are recorded as warnings and surfaced to the caller via
 * `readPositionsForProvider` so partial scans are visible to the agent.
 */
async function discoverTokenIdsByEvents(
  client: ReturnType<typeof getPublicClient>,
  positionManager: `0x${string}`,
  owner: `0x${string}`,
  maxPositions: number
): Promise<{ ownedIds: bigint[]; warnings: string[] }> {
  const warnings: string[] = [];
  const latestBlock = await client.getBlockNumber();

  // Scan backward in chunks. Most users' positions are recent, so
  // scanning from the tip is fast and handles the common case in 1-2 RPCs.
  const CHUNK_SIZE = 100_000n;
  // Cap total scan depth to ~20M blocks (well beyond Mantle's full history)
  const MIN_BLOCK = latestBlock > 20_000_000n ? latestBlock - 20_000_000n : 0n;
  const MAX_RETRY_DEPTH = 3;

  const candidateIds = new Set<bigint>();
  // Matches the downstream `sliceLimit = maxPositions * 2` cap — once we have
  // this many candidate IDs, further scanning cannot affect the verified set.
  const earlyExitThreshold = maxPositions * 2;

  // Recursive best-effort window scan: halves on RPC rejection up to
  // MAX_RETRY_DEPTH levels (covers public RPCs that cap at 10k–50k blocks).
  async function scanRange(
    fromBlock: bigint,
    toBlock: bigint,
    depth: number
  ): Promise<void> {
    try {
      const logs = await client.getContractEvents({
        address: positionManager,
        abi: V3_POSITION_MANAGER_ABI,
        eventName: "Transfer",
        args: { to: owner },
        fromBlock,
        toBlock
      });
      for (const log of logs) {
        const tokenId = (log.args as { tokenId?: bigint }).tokenId;
        if (tokenId != null) candidateIds.add(tokenId);
      }
    } catch {
      const span = toBlock - fromBlock;
      if (depth >= MAX_RETRY_DEPTH || span < 2n) {
        warnings.push(
          `Event-log scan failed for blocks ${fromBlock}-${toBlock} after ${depth} retry level(s); some historical positions may be missing.`
        );
        return;
      }
      const mid = fromBlock + span / 2n;
      await scanRange(fromBlock, mid, depth + 1);
      await scanRange(mid + 1n, toBlock, depth + 1);
    }
  }

  let toBlock = latestBlock;
  while (toBlock > MIN_BLOCK) {
    // Clamp the final chunk's fromBlock to MIN_BLOCK instead of overscanning
    // up to ~100k blocks below it. This was the F-4 bug (review 2026-04-16).
    const fromBlock = toBlock > MIN_BLOCK + CHUNK_SIZE ? toBlock - CHUNK_SIZE + 1n : MIN_BLOCK;
    await scanRange(fromBlock, toBlock, 0);
    // Stop once we have enough candidates for the verification step — extra
    // chunks cannot affect the final `ownedIds` since they are discarded by
    // the `sliceLimit` slice below.
    if (candidateIds.size >= earlyExitThreshold) break;
    if (fromBlock <= MIN_BLOCK) break;
    toBlock = fromBlock - 1n;
  }

  if (candidateIds.size === 0) return { ownedIds: [], warnings };

  // Batch-verify current ownership — tokens may have been transferred away.
  // Candidates are truncated to maxPositions*2 (earlyExitThreshold) to bound
  // multicall size; this can silently drop currently-owned positions when a
  // wallet has many more historical transfers than live positions. Emit a
  // warning if we truncate.
  const allCandidates = Array.from(candidateIds);
  const idList = allCandidates.slice(0, earlyExitThreshold);
  if (allCandidates.length > earlyExitThreshold) {
    warnings.push(
      `Candidate token IDs truncated from ${allCandidates.length} to ${earlyExitThreshold} (maxPositions*2). Old positions may be missing; raise maxPositions to widen the window.`
    );
  }
  const ownerOfCalls = idList.map((id) => ({
    address: positionManager,
    abi: V3_POSITION_MANAGER_ABI,
    functionName: "ownerOf" as const,
    args: [id] as const
  }));

  const ownerOfResults = await client.multicall({ contracts: ownerOfCalls });

  const ownedIds: bigint[] = [];
  const ownerLower = owner.toLowerCase();
  for (let i = 0; i < ownerOfResults.length && ownedIds.length < maxPositions; i++) {
    const res = ownerOfResults[i];
    if (
      res.status === "success" &&
      typeof res.result === "string" &&
      res.result.toLowerCase() === ownerLower
    ) {
      ownedIds.push(idList[i]);
    }
  }

  return { ownedIds, warnings };
}

async function readPositionsForProvider(
  provider: V3Provider,
  owner: `0x${string}`,
  network: Network,
  includeEmpty: boolean
): Promise<{ positions: PositionResult[]; warnings: string[] }> {
  const warnings: string[] = [];
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
  if (count === 0) return { positions: [], warnings };

  const cappedCount = Math.min(count, MAX_POSITIONS_PER_PROVIDER);
  if (count > MAX_POSITIONS_PER_PROVIDER) {
    warnings.push(
      `Wallet holds ${count} ${provider} position NFTs, capped to ${MAX_POSITIONS_PER_PROVIDER}.`
    );
  }

  // Step 2: Get all token IDs
  // Try ERC721Enumerable first (tokenOfOwnerByIndex). Agni and some V3
  // forks do NOT implement Enumerable, so every multicall entry will fail.
  // When that happens, fall back to Transfer event log scanning.
  let tokenIds: bigint[] = [];

  const indexCalls = Array.from({ length: cappedCount }, (_, i) => ({
    address: positionManager,
    abi: V3_POSITION_MANAGER_ABI,
    functionName: "tokenOfOwnerByIndex" as const,
    args: [owner, BigInt(i)] as const
  }));

  const indexResults = await client.multicall({ contracts: indexCalls });

  for (const res of indexResults) {
    if (res.status === "success") {
      tokenIds.push(res.result as bigint);
    }
  }

  // Fallback: if Enumerable is unsupported, discover token IDs from
  // Transfer event logs and verify current ownership via ownerOf.
  if (tokenIds.length === 0 && count > 0) {
    const scan = await discoverTokenIdsByEvents(client, positionManager, owner, cappedCount);
    tokenIds = scan.ownedIds;
    for (const w of scan.warnings) warnings.push(w);
  }

  if (tokenIds.length === 0) return { positions: [], warnings };

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

  if (rawPositions.length === 0) return { positions: [], warnings };

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

  return { positions, warnings };
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
  const allWarnings: Array<{ provider: string; warning: string }> = [];
  const errors: Array<{ provider: string; error: string }> = [];

  // Scan each provider
  const results = await Promise.allSettled(
    providers.map((p) => readPositionsForProvider(p, owner, network, includeEmpty))
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      allPositions.push(...result.value.positions);
      for (const w of result.value.warnings) {
        allWarnings.push({ provider: providers[i], warning: w });
      }
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
    warnings: allWarnings.length > 0 ? allWarnings : undefined,
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
 * Common V3 fee tiers scanned by the legacy on-chain pool-discovery path.
 *
 * Kept as documentation only — `findPools` no longer enumerates factories.
 * The canonical list lives in `pool-discovery.ts` and is still used by the
 * quote/build code paths:
 *   100=0.01%, 500=0.05%, 2500=0.25%, 3000=0.3%, 10000=1%
 */

interface FoundPool {
  provider: string;
  pool_address: string;
  fee_tier?: number;
  bin_step?: number;
  liquidity_raw: string;
  /**
   * Units for `liquidity_raw`. Callers MUST NOT compare `liquidity_raw` across
   * different `liquidity_unit` values — the underlying scales are not
   * dimensionally compatible.
   *   - "dexscreener_usd_snapshot": USD value from the local
   *     `dexscreener-pools.json` snapshot. Comparable across pools AND across
   *     providers; this is the unit produced by the zero-RPC discovery path.
   *     Snapshot is regenerated out-of-band via `scripts/refresh-pools.mjs`.
   *   - "v3_virtual_liquidity" (legacy): Uniswap V3 `pool.liquidity()`
   *     (unitless, ~sqrt(xy)). Kept in the union for back-compat with any
   *     cached/persisted output; no longer emitted.
   *   - "lb_active_bin_native_mixed" (legacy): Merchant Moe active-bin
   *     (reserveX + reserveY) summed in native token decimals — mixed across
   *     tokens. Kept in the union for back-compat; no longer emitted.
   */
  liquidity_unit?:
    | "dexscreener_usd_snapshot"
    | "v3_virtual_liquidity"
    | "lb_active_bin_native_mixed";
  has_liquidity: boolean;
  /**
   * The tokens that were used to query the factory for this pool. Returned
   * as (token_a, token_b) where `token_a` is the query anchor and `token_b`
   * is the counterpart. The V3 and LB factories are symmetric, so this is
   * NOT the on-chain token0/token1 ordering — callers that need the exact
   * on-chain ordering must read `token0()`/`getTokenX()` from the pool.
   *
   * This field is always populated, including in pair mode where it simply
   * mirrors the top-level `token_a`/`token_b`. In single-side mode it is the
   * ONLY way to tell which counterpart each pool is for.
   */
  token_a: TokenInfo;
  token_b: TokenInfo;
  /** DexScreener market data — null when DexScreener data is unavailable. */
  tvl_usd?: number | null;
  volume_24h_usd?: number | null;
  fee_apr_pct?: number | null;
}

/**
 * Pool-discovery for findPools — reads `config/dexscreener-pools.json` (the
 * curated local snapshot, regenerated out-of-band via
 * `scripts/refresh-pools.mjs`) and returns FoundPool entries that match
 * `anchor` plus one or more `counterparts`.
 *
 * This replaces the previous on-chain factory scan (Agni + Fluxion V3
 * `getPool()` and Merchant Moe LB `getLBPairInformation()`) along with the
 * per-pool liquidity read (`pool.liquidity()` / `pool.getBin(activeId)`).
 * Rationale: the snapshot is authoritative for "which pools exist with
 * liquidity_usd >= $1000", already passes on-chain verification during
 * refresh, and is always fresher than a live factory enumeration that can
 * miss routerVersion/poolType metadata. Going JSON-only cuts ~100-300 RPC
 * calls per findPools invocation down to zero.
 *
 * Behaviour:
 *   - Mainnet: filter `dexscreener-pools.json` for entries where `anchor`
 *     appears as EITHER baseToken or quoteToken, and the other side matches
 *     any address in `counterparts`. `token_a` is always the anchor, `token_b`
 *     is the counterpart that matched (NOT the on-chain token0/token1 order).
 *   - Sepolia / snapshot-miss: fall back to `listAllPairs()` from the static
 *     pair registry so sepolia — which has no DexScreener snapshot yet — and
 *     any mainnet pool not yet captured by DexScreener still resolve.
 *   - `liquidity_raw` = the snapshot's `liquidityUsd` (integer string, USD
 *     floored). `liquidity_unit = "dexscreener_usd_snapshot"`. This is
 *     comparable across pools AND across providers — the key UX win over
 *     the old V3/LB mixed-units numbers.
 *   - `has_liquidity = (liquidityUsd ?? 0) > 0`. For static-registry entries
 *     (no liquidityUsd) we treat them as `has_liquidity: true` so they still
 *     pass through the downstream DexScreener enrichment pass that fills in
 *     TVL/volume/APR. If the live enrichment returns nothing, they remain
 *     visible with liquidity_raw="0".
 *   - Pools are deduped by lowercased pool address across both sources.
 *   - Self-pairs and counterpart duplicates are filtered defensively.
 */
function scanPairsFromSnapshot(
  network: Network,
  anchor: TokenInfo,
  counterparts: TokenInfo[]
): FoundPool[] {
  const anchorLc = anchor.address.toLowerCase();

  // Dedupe counterparts by lowercased address; drop anchor==counterpart cases.
  const cpByAddr = new Map<string, TokenInfo>();
  for (const cp of counterparts) {
    const key = cp.address.toLowerCase();
    if (key === anchorLc) continue;
    if (cpByAddr.has(key)) continue;
    cpByAddr.set(key, cp);
  }
  if (cpByAddr.size === 0) return [];

  const pools: FoundPool[] = [];
  const seen = new Set<string>(); // lowercased pool address

  // --- Source 1: local DexScreener snapshot (mainnet only today) ---------
  if (network === "mainnet") {
    const snapshot = loadDexScreenerPoolsSnapshot();
    for (const entry of snapshot.pools) {
      const baseLc = entry.baseToken?.address?.toLowerCase();
      const quoteLc = entry.quoteToken?.address?.toLowerCase();
      if (!baseLc || !quoteLc) continue;

      // Determine which side is the anchor and which is the counterpart.
      let counterpart: TokenInfo | null = null;
      if (baseLc === anchorLc && cpByAddr.has(quoteLc)) {
        counterpart = cpByAddr.get(quoteLc)!;
      } else if (quoteLc === anchorLc && cpByAddr.has(baseLc)) {
        counterpart = cpByAddr.get(baseLc)!;
      } else {
        continue; // not an anchor pool, or counterpart not in scope
      }

      const poolLc = entry.pool.toLowerCase();
      if (seen.has(poolLc)) continue;
      seen.add(poolLc);

      const liqUsd = entry.liquidityUsd ?? 0;
      // USD is float in the snapshot; floor to an integer string so
      // `liquidity_raw` stays decimal-integer like the old field.
      const liqRaw = Math.max(0, Math.floor(liqUsd)).toString();

      pools.push({
        provider: entry.provider,
        pool_address: entry.pool,
        ...(entry.feeTier != null ? { fee_tier: entry.feeTier } : {}),
        ...(entry.binStep != null ? { bin_step: entry.binStep } : {}),
        liquidity_raw: liqRaw,
        liquidity_unit: "dexscreener_usd_snapshot",
        has_liquidity: liqUsd > 0,
        token_a: anchor,
        token_b: counterpart
      });
    }
  }

  // --- Source 2: static pair registry — fallback for sepolia AND for any
  // mainnet pool not yet captured by the DexScreener snapshot. Deduped
  // against source 1 by lowercased pool address. -------------------------
  for (const pair of listAllPairs()) {
    const aLc = pair.tokenAAddress.toLowerCase();
    const bLc = pair.tokenBAddress.toLowerCase();

    let counterpart: TokenInfo | null = null;
    if (aLc === anchorLc && cpByAddr.has(bLc)) {
      counterpart = cpByAddr.get(bLc)!;
    } else if (bLc === anchorLc && cpByAddr.has(aLc)) {
      counterpart = cpByAddr.get(aLc)!;
    } else {
      continue;
    }

    const poolLc = pair.pool.toLowerCase();
    if (seen.has(poolLc)) continue;
    seen.add(poolLc);

    const isV3 = pair.provider === "agni" || pair.provider === "fluxion";
    pools.push({
      provider: pair.provider,
      pool_address: pair.pool,
      ...(isV3
        ? { fee_tier: (pair as { feeTier: number }).feeTier }
        : { bin_step: (pair as { binStep: number }).binStep }),
      // No liquidity info in the static registry. Report 0 but keep
      // has_liquidity=true so downstream DexScreener enrichment still
      // runs and may fill in tvl_usd/volume_24h_usd.
      liquidity_raw: "0",
      liquidity_unit: "dexscreener_usd_snapshot",
      has_liquidity: true,
      token_a: anchor,
      token_b: counterpart
    });
  }

  return pools;
}

/**
 * Test-only re-export of `scanPairsFromSnapshot`. Consumed by
 * `tests/defi-find-pools.test.ts` to pin down the JSON-only discovery
 * contract without spinning up a public client. Prefix with `_` to signal
 * "internal — not part of the public tool API".
 */
export function _scanPairsFromSnapshot(
  network: Network,
  anchor: TokenInfo,
  counterparts: TokenInfo[]
): ReturnType<typeof scanPairsFromSnapshot> {
  return scanPairsFromSnapshot(network, anchor, counterparts);
}

/**
 * `scripts/refresh-pools.mjs` (fetch + filter + on-chain verify + write)
 * and independently sanity-checked with `scripts/verify-pools.mjs`. Using
 * this instead of the live `/token-pairs` endpoint makes counterpart
 * discovery fully deterministic and network-free.
 */
interface DexScreenerPoolsSnapshotEntry {
  provider: string;
  pool: string;
  baseToken: { symbol: string; address: string };
  quoteToken: { symbol: string; address: string };
  feeTier?: number;
  binStep?: number;
  liquidityUsd?: number;
}

interface DexScreenerPoolsSnapshot {
  meta: { fetched_at: string | null; total_pools: number };
  pools: DexScreenerPoolsSnapshotEntry[];
}

function loadDexScreenerPoolsSnapshot(): DexScreenerPoolsSnapshot {
  const raw = dexscreenerPoolsSnapshot as {
    _meta?: { fetched_at?: string; total_pools?: number };
    pools?: DexScreenerPoolsSnapshotEntry[];
  };
  return {
    meta: {
      fetched_at: raw?._meta?.fetched_at ?? null,
      total_pools: raw?._meta?.total_pools ?? (Array.isArray(raw?.pools) ? raw.pools.length : 0)
    },
    pools: Array.isArray(raw?.pools) ? raw.pools : []
  };
}

/**
 * Build the list of counterpart tokens to scan against `anchor` in single-side
 * findPools mode. We deliberately union THREE independent LOCAL sources so
 * no pool is silently missed AND we never fail because a live API is down:
 *
 *   1. `config/dexscreener-pools.json` — local snapshot of DexScreener's
 *      Mantle pool set (liquidity ≥ $1000, fee tiers / bin steps already
 *      verified on-chain). This replaces the old live call to the
 *      `/token-pairs/v1` endpoint — same data, zero network dependency.
 *   2. The static pair registry (`listAllPairs()`) — curated from
 *      DexScreener + GeckoTerminal + protocol docs, a superset of (1).
 *   3. Every token in `MANTLE_TOKENS[network]` — brute-force fallback so
 *      on-chain-only pools between the anchor and any well-known token are
 *      still discovered when neither snapshot mentions them.
 *
 * The union is keyed by lowercased address so duplicates collapse. The
 * anchor itself is excluded. Counterpart discovery is synchronous with
 * respect to the network — live DexScreener is still called LATER for
 * market-data enrichment (TVL/volume/APR) on the pools we actually found,
 * but the "don't miss pools" guarantee no longer rides on that call.
 *
 * @returns `sources` lists the sources that were CHECKED (not just matched);
 *          this is useful to debug "did we actually look at X?" without
 *          depending on whether X happened to have matches. `snapshot_meta`
 *          surfaces the snapshot's fetched_at timestamp so callers can
 *          judge staleness.
 */
export function _collectCounterpartsForSingleSide(
  anchor: TokenInfo,
  network: Network
): {
  counterparts: TokenInfo[];
  sources: string[];
  snapshot_meta: { fetched_at: string | null; total_pools: number };
} {
  return collectCounterpartsForSingleSide(anchor, network);
}

function collectCounterpartsForSingleSide(
  anchor: TokenInfo,
  network: Network
): {
  counterparts: TokenInfo[];
  sources: string[];
  snapshot_meta: { fetched_at: string | null; total_pools: number };
} {
  const anchorAddr = anchor.address.toLowerCase();
  const seen = new Map<string, TokenInfo>();

  const add = (addr: string, symbol: string | null, decimals: number | null) => {
    if (!addr) return;
    if (!isAddress(addr, { strict: false })) return;
    const key = addr.toLowerCase();
    if (key === anchorAddr) return;
    if (seen.has(key)) return;
    seen.set(key, {
      address: getAddress(addr),
      symbol,
      decimals
    });
  };

  // `sources` captures which sources were CHECKED, regardless of whether
  // they produced counterparts. "`static_pair_registry` not in sources"
  // unambiguously means "we did not consult it", not "we consulted and
  // found nothing".
  const sources: string[] = [];
  const snapshot = loadDexScreenerPoolsSnapshot();

  // 1) Local DexScreener pool snapshot. The snapshot is mainnet-only today;
  //    if we add sepolia coverage later, gate this by network.
  if (network === "mainnet") {
    sources.push("dexscreener_pools_snapshot");
    for (const entry of snapshot.pools) {
      const baseAddr = entry.baseToken?.address;
      const quoteAddr = entry.quoteToken?.address;
      if (baseAddr && baseAddr.toLowerCase() === anchorAddr) {
        add(quoteAddr, entry.quoteToken?.symbol ?? null, null);
      } else if (quoteAddr && quoteAddr.toLowerCase() === anchorAddr) {
        add(baseAddr, entry.baseToken?.symbol ?? null, null);
      }
    }
  }

  // 2) Static pair registry — curated superset of the DexScreener snapshot.
  //    Always consulted regardless of network.
  sources.push("static_pair_registry");
  for (const pair of listAllPairs()) {
    const aAddr = pair.tokenAAddress;
    const bAddr = pair.tokenBAddress;
    if (aAddr.toLowerCase() === anchorAddr) {
      add(bAddr, pair.tokenB, null);
    } else if (bAddr.toLowerCase() === anchorAddr) {
      add(aAddr, pair.tokenA, null);
    }
  }

  // 3) Every registry token — brute-force fallback so we don't miss an
  //    on-chain-only pool against a well-known token. Symbols + decimals
  //    come from the registry (free, no RPC).
  sources.push("mantle_token_registry");
  for (const entry of Object.values(MANTLE_TOKENS[network])) {
    if (entry.address === "native") continue; // can't pair native gas token in V3/LB
    if (entry.address.toLowerCase() === anchorAddr) continue;
    add(entry.address, entry.symbol, entry.decimals);
  }

  return {
    counterparts: Array.from(seen.values()),
    sources,
    snapshot_meta: snapshot.meta
  };
}

async function findPools(
  args: Record<string, unknown>
): Promise<unknown> {
  const { network } = normalizeNetwork(args);

  // Single-side mode: accept just one of token_a / token_b. At least one
  // must be provided. Both-provided is pair mode (unchanged behavior).
  const tokenAInputRaw = args.token_a;
  const tokenBInputRaw = args.token_b;
  const hasA =
    typeof tokenAInputRaw === "string" && tokenAInputRaw.trim().length > 0;
  const hasB =
    typeof tokenBInputRaw === "string" && tokenBInputRaw.trim().length > 0;

  if (!hasA && !hasB) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      "At least one of token_a or token_b is required.",
      "Provide a token symbol/address in token_a (or token_b) to search for pools involving that token. Provide both to restrict the search to a specific pair.",
      { field: "token_a" }
    );
  }

  const warnings: string[] = [];
  let mode: "pair" | "single_side";
  let anchor: TokenInfo;
  let counterparts: TokenInfo[];
  let pairTokenA: TokenInfo | null = null;
  let pairTokenB: TokenInfo | null = null;
  let counterpartSources: string[] = [];
  // Populate snapshot_meta eagerly so BOTH pair and single-side modes surface
  // the snapshot freshness. Previously only single-side mode reported it,
  // leaving the most action-sensitive path (pair mode, used right before
  // add-LP) with no staleness signal. The call is cheap — it reads the
  // statically-imported JSON object.
  let snapshotMeta: { fetched_at: string | null; total_pools: number } | null =
    loadDexScreenerPoolsSnapshot().meta;

  if (hasA && hasB) {
    mode = "pair";
    const a = await resolveTokenInfo((tokenAInputRaw as string).trim(), network);
    const b = await resolveTokenInfo((tokenBInputRaw as string).trim(), network);
    if (a.address.toLowerCase() === b.address.toLowerCase()) {
      throw new MantleMcpError(
        "INVALID_INPUT",
        "token_a and token_b must be different tokens.",
        "Use two distinct tokens to query a pair. For single-token discovery, provide only one of token_a or token_b.",
        { token_a: a.address, token_b: b.address }
      );
    }
    anchor = a;
    counterparts = [b];
    pairTokenA = a;
    pairTokenB = b;
  } else {
    mode = "single_side";
    const provided = (hasA ? tokenAInputRaw : tokenBInputRaw) as string;
    anchor = await resolveTokenInfo(provided.trim(), network);
    const collected = collectCounterpartsForSingleSide(anchor, network);
    counterparts = collected.counterparts;
    counterpartSources = collected.sources;
    snapshotMeta = collected.snapshot_meta;
    if (counterparts.length === 0) {
      // No candidates at all — return empty result rather than silently
      // scanning zero pairs.
      return {
        mode,
        anchor_token: {
          address: anchor.address,
          symbol: anchor.symbol,
          decimals: anchor.decimals
        },
        token_a: hasA
          ? { address: anchor.address, symbol: anchor.symbol, decimals: anchor.decimals }
          : null,
        token_b: hasB
          ? { address: anchor.address, symbol: anchor.symbol, decimals: anchor.decimals }
          : null,
        pools: [],
        recommended_pool: null,
        total_found: 0,
        with_liquidity: 0,
        scanned: {
          pool_sources: network === "mainnet"
            ? ["dexscreener_pools_snapshot", "static_pair_registry"]
            : ["static_pair_registry"],
          counterparts_scanned: 0,
          counterpart_sources: counterpartSources,
          snapshot_meta: snapshotMeta
        },
        warnings: [
          ...warnings,
          "No counterpart tokens found for single-side discovery."
        ],
        dexscreener_warning: null,
        queried_at_utc: nowUtc()
      };
    }
  }

  // ── Pool discovery — zero RPC, reads from local snapshot + static
  //    registry. See scanPairsFromSnapshot for sources and fallbacks. ─────
  const pools = scanPairsFromSnapshot(network, anchor, counterparts);

  // ── Fetch DexScreener market data for all pools with liquidity ────────
  const poolsWithLiquidity = pools.filter((p) => p.has_liquidity);
  let dexScreenerWarning: string | null = null;

  if (poolsWithLiquidity.length > 0) {
    const chainId = resolveDexScreenerChain(network);
    if (chainId) {
      // DexScreener supports batch queries: /latest/dex/pairs/{chain}/{addr1,addr2,...}
      const BATCH_SIZE = 30;
      const allAddresses = poolsWithLiquidity.map((p) => p.pool_address);
      const dexScreenerMap = new Map<string, DexScreenerPairData>();

      for (let i = 0; i < allAddresses.length; i += BATCH_SIZE) {
        const batch = allAddresses.slice(i, i + BATCH_SIZE);
        const url = `${DEXSCREENER_API_BASE}/latest/dex/pairs/${chainId}/${batch.join(",")}`;
        const payload = await fetchJsonSafe(url);
        if (payload && typeof payload === "object" && Array.isArray(payload.pairs)) {
          for (const pair of payload.pairs as DexScreenerPairData[]) {
            const addr = pair.pairAddress?.toLowerCase();
            if (addr) {
              dexScreenerMap.set(addr, pair);
            }
          }
        } else {
          dexScreenerWarning = "DexScreener query failed or returned empty. TVL/volume data may be incomplete.";
        }
      }

      // Enrich pools with market data (only pools with liquidity were sent to DexScreener)
      const SANITY_LIMIT_USD = 10_000_000_000; // $10 B — flag implausible values
      const outlierPools: string[] = [];
      for (const pool of poolsWithLiquidity) {
        const pair = dexScreenerMap.get(pool.pool_address.toLowerCase());
        if (pair) {
          const tvl = asFiniteNumber(pair.liquidity?.usd);
          const vol = asFiniteNumber(pair.volume?.h24);

          // Sanity-check: skip implausibly large values (OPT-M-5)
          const tvlOk = tvl == null || tvl <= SANITY_LIMIT_USD;
          const volOk = vol == null || vol <= SANITY_LIMIT_USD;
          if (!tvlOk || !volOk) {
            outlierPools.push(pool.pool_address);
          }
          pool.tvl_usd = tvlOk ? tvl : null;
          pool.volume_24h_usd = volOk ? vol : null;

          // Compute fee APR if we have TVL and volume (use sanitized values)
          const safeTvl = pool.tvl_usd;
          const safeVol = pool.volume_24h_usd;
          if (safeTvl != null && safeTvl > 0 && safeVol != null) {
            let feeRate: number;
            if (pool.fee_tier != null) {
              feeRate = pool.fee_tier / 1_000_000; // V3: 3000 → 0.003
            } else if (pool.bin_step != null) {
              // LB: base fee ≈ binStep / 10_000 (binStep is in bps; e.g. 25 → 0.25%)
              feeRate = pool.bin_step / 10_000;
            } else {
              feeRate = 0.003; // fallback
            }
            pool.fee_apr_pct = Math.round((safeVol * feeRate * 365) / safeTvl * 100) / 100;
          }
        }
      }
      if (outlierPools.length > 0) {
        dexScreenerWarning = (dexScreenerWarning ? dexScreenerWarning + " " : "") +
          `${outlierPools.length} pool(s) had implausibly large TVL or 24h volume (> $10 B) and were excluded from scoring: ${outlierPools.join(", ")}.`;
      }
    }
  }

  // Sort: pools with liquidity first, then by composite score (normalized TVL × 0.6 + normalized volume × 0.4)
  // Normalize both metrics to [0, 1] within the pool set so the 0.6/0.4 weights have their intended effect.
  const allTvls = pools.map((p) => p.tvl_usd ?? 0);
  const allVols = pools.map((p) => p.volume_24h_usd ?? 0);
  const maxTvl = Math.max(...allTvls, 1); // avoid divide-by-zero
  const maxVol = Math.max(...allVols, 1);

  pools.sort((a, b) => {
    if (a.has_liquidity && !b.has_liquidity) return -1;
    if (!a.has_liquidity && b.has_liquidity) return 1;
    // Among pools with liquidity, sort by normalized composite score:
    const scoreA = ((a.tvl_usd ?? 0) / maxTvl) * 0.6 + ((a.volume_24h_usd ?? 0) / maxVol) * 0.4;
    const scoreB = ((b.tvl_usd ?? 0) / maxTvl) * 0.6 + ((b.volume_24h_usd ?? 0) / maxVol) * 0.4;
    if (scoreA !== scoreB) return scoreB - scoreA;
    return a.provider.localeCompare(b.provider);
  });

  // Pick recommended pool: highest composite score among pools with liquidity
  let recommended_pool: {
    pool_address: string;
    provider: string;
    fee_tier?: number;
    bin_step?: number;
    token_a: TokenInfo;
    token_b: TokenInfo;
    tvl_usd: number | null;
    volume_24h_usd: number | null;
    fee_apr_pct: number | null;
    reason: string;
  } | null = null;

  // Pick recommended pool: highest composite score among pools with liquidity AND positive TVL.
  // Pools with zero TVL but non-zero volume are excluded (potential wash trading).
  const poolsWithMarketData = pools.filter(
    (p) => p.has_liquidity && p.tvl_usd != null && p.tvl_usd > 0
  );
  if (poolsWithMarketData.length > 0) {
    const best = poolsWithMarketData[0]; // already sorted by composite score
    const reasons: string[] = [];
    if (best.tvl_usd != null) reasons.push(`TVL $${best.tvl_usd.toLocaleString()}`);
    if (best.volume_24h_usd != null) reasons.push(`24h volume $${best.volume_24h_usd.toLocaleString()}`);
    if (best.fee_apr_pct != null) reasons.push(`fee APR ${best.fee_apr_pct}%`);
    recommended_pool = {
      pool_address: best.pool_address,
      provider: best.provider,
      fee_tier: best.fee_tier,
      bin_step: best.bin_step,
      token_a: best.token_a,
      token_b: best.token_b,
      tvl_usd: best.tvl_usd ?? null,
      volume_24h_usd: best.volume_24h_usd ?? null,
      fee_apr_pct: best.fee_apr_pct ?? null,
      reason: `Highest composite score (TVL × 0.6 + volume × 0.4). ${reasons.join(", ")}.`
    };
  }

  // Back-compat: in pair mode, top-level `token_a`/`token_b` mirror the
  // provided inputs. In single-side mode, only the provided side is filled
  // in and the other side is null — downstream formatters should check
  // `mode` and/or each pool's per-pool `token_a`/`token_b`.
  const outTokenA = mode === "pair"
    ? pairTokenA
    : hasA ? anchor : null;
  const outTokenB = mode === "pair"
    ? pairTokenB
    : hasB ? anchor : null;

  return {
    mode,
    anchor_token: {
      address: anchor.address,
      symbol: anchor.symbol,
      decimals: anchor.decimals
    },
    token_a: outTokenA
      ? {
          address: outTokenA.address,
          symbol: outTokenA.symbol,
          decimals: outTokenA.decimals
        }
      : null,
    token_b: outTokenB
      ? {
          address: outTokenB.address,
          symbol: outTokenB.symbol,
          decimals: outTokenB.decimals
        }
      : null,
    pools,
    recommended_pool,
    total_found: pools.length,
    with_liquidity: pools.filter((p) => p.has_liquidity).length,
    scanned: {
      pool_sources: network === "mainnet"
        ? ["dexscreener_pools_snapshot", "static_pair_registry"]
        : ["static_pair_registry"],
      counterparts_scanned: counterparts.length,
      counterpart_sources:
        mode === "single_side"
          ? counterpartSources
          : ["explicit_pair"],
      snapshot_meta: snapshotMeta
    },
    warnings: warnings.length > 0 ? warnings : undefined,
    dexscreener_warning: dexScreenerWarning,
    queried_at_utc: nowUtc()
  };
}

// =========================================================================
// Tool 7: mantle_discoverTopPools
// =========================================================================

/**
 * DexScreener pair shape returned by the /token-pairs/v1 and
 * /latest/dex/pairs endpoints. Kept minimal – only fields we read.
 */
interface DSPairForDiscovery {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  liquidity?: { usd?: number | string | null };
  volume?: { h24?: number | string | null; h6?: number | string | null };
  priceChange?: { h24?: number | string | null; h6?: number | string | null };
  fdv?: number | null;
}

/**
 * Map DexScreener dexId → our internal provider name.
 * Fluxion uses its factory address as dexId on DexScreener.
 */
function dexIdToProviderName(
  dexId: string | undefined
): "agni" | "fluxion" | "merchant_moe" | null {
  const id = (dexId ?? "").toLowerCase();
  if (id === "agni") return "agni";
  if (id === "merchantmoe") return "merchant_moe";
  // Fluxion factory address
  if (id === "0xf883162ed9c7e8ef604214c964c678e40c9b737c") return "fluxion";
  return null;
}

/**
 * Inline ABI to read fee() from a Uniswap V3 pool.
 */
const V3_FEE_READ_ABI = [
  {
    type: "function" as const,
    name: "fee" as const,
    stateMutability: "view" as const,
    inputs: [],
    outputs: [{ name: "", type: "uint24" as const }]
  }
] as const;

/**
 * Inline ABI to read getStaticFeeParameters() from a Merchant Moe LB V2.2 pair.
 *
 * Returns baseFactor, filterPeriod, decayPeriod, reductionFactor,
 * variableFeeControl, protocolShare, maxVolatilityAccumulator.
 * We only need baseFactor to compute the base fee.
 */
const LB_STATIC_FEE_PARAMS_ABI = [
  {
    type: "function" as const,
    name: "getStaticFeeParameters" as const,
    stateMutability: "view" as const,
    inputs: [],
    outputs: [
      { name: "baseFactor", type: "uint16" as const },
      { name: "filterPeriod", type: "uint16" as const },
      { name: "decayPeriod", type: "uint16" as const },
      { name: "reductionFactor", type: "uint16" as const },
      { name: "variableFeeControl", type: "uint24" as const },
      { name: "protocolShare", type: "uint16" as const },
      { name: "maxVolatilityAccumulator", type: "uint24" as const }
    ]
  }
] as const;

interface TopPoolEntry {
  rank: number;
  pool_address: string;
  provider: string;
  token_a: { symbol: string; address: string };
  token_b: { symbol: string; address: string };
  fee_tier?: number;
  fee_rate_pct: number;
  /** Whether fee_rate_pct was read from authoritative on-chain data. */
  fee_verified: boolean;
  bin_step?: number;
  tvl_usd: number | null;
  volume_24h_usd: number | null;
  fee_apr_pct: number | null;
  /** Whether fee_apr_pct is based on verified on-chain fee or an estimate. */
  apr_verified: boolean;
  price_change_24h_pct: number | null;
  source: "registry" | "discovered";
}

type DiscoveryStatus = "complete" | "partial" | "degraded";

/**
 * Discover the top LP pools on Mantle DEXes.
 *
 * Strategy:
 *   1. Collect all known pool addresses from the registry.
 *   2. Query DexScreener for each major base token on Mantle to discover
 *      additional pools (including trending meme tokens).
 *   3. Batch-fetch DexScreener data for registry pools not yet covered.
 *   4. For V3 pools, read fee() on-chain; for LB pools, read
 *      getStaticFeeParameters() on-chain for authoritative fee data.
 *   5. Calculate fee APR = (volume24h × feeRate × 365) / TVL.
 *   6. Sort by the requested metric and return top N.
 *
 * Discovery completeness is tracked and reported via discovery_status.
 */
async function discoverTopPools(
  args: Record<string, unknown>
): Promise<unknown> {
  const { network } = normalizeNetwork(args);
  const sortBy = typeof args.sort_by === "string" ? args.sort_by : "volume";
  const minTvl = typeof args.min_tvl_usd === "number" ? args.min_tvl_usd : 0;
  const limit = typeof args.limit === "number" ? Math.min(Math.max(args.limit, 1), 50) : 20;
  const providerFilter =
    typeof args.provider === "string" ? args.provider.toLowerCase() : null;

  const chainId = resolveDexScreenerChain(network);
  if (!chainId) {
    return {
      error: "DexScreener is not available for this network.",
      top_pools: [],
      total_scanned: 0,
      discovery_status: "degraded" as DiscoveryStatus
    };
  }

  const client = getPublicClient(network);
  const warnings: string[] = [];

  // ── Step 1: Build registry lookup ──────────────────────────────────────
  // FIX-3: Store registry token addresses alongside symbols so we never
  // mix DexScreener's baseToken/quoteToken ordering with registry symbols.
  const allPairs = listAllPairs();
  const registryByAddr = new Map<
    string,
    {
      provider: string;
      fee_tier?: number;
      bin_step?: number;
      tokenA: string;
      tokenB: string;
      tokenAAddress: string;
      tokenBAddress: string;
    }
  >();

  for (const pair of allPairs) {
    const addr = pair.pool.toLowerCase();
    registryByAddr.set(addr, {
      provider: pair.provider,
      fee_tier: "feeTier" in pair ? pair.feeTier : undefined,
      bin_step: "binStep" in pair ? pair.binStep : undefined,
      tokenA: pair.tokenA,
      tokenB: pair.tokenB,
      tokenAAddress: pair.tokenAAddress,
      tokenBAddress: pair.tokenBAddress
    });
  }

  // ── Step 2: Discover pools via DexScreener token-pairs queries ─────────
  // FIX-1: Track query success/failure for completeness reporting.
  const DISCOVERY_TOKENS = [
    DEX_TOKENS.WMNT,
    DEX_TOKENS.USDC,
    DEX_TOKENS.USDT0,
    DEX_TOKENS.WETH,
    DEX_TOKENS.mETH,
    DEX_TOKENS.USDT,
    DEX_TOKENS.USDe
  ];

  const poolDataMap = new Map<string, DSPairForDiscovery>();
  let seedQueriesSucceeded = 0;
  let seedQueriesFailed = 0;

  const tokenPairPromises = DISCOVERY_TOKENS.map(async (tokenAddr) => {
    const url = `${DEXSCREENER_API_BASE}/token-pairs/v1/${chainId}/${tokenAddr}`;
    const payload = await fetchJsonSafe(url);
    return Array.isArray(payload) ? (payload as DSPairForDiscovery[]) : [];
  });

  const tokenPairResults = await Promise.allSettled(tokenPairPromises);

  for (const result of tokenPairResults) {
    if (result.status !== "fulfilled") {
      // Only count network/HTTP errors as failures; an empty array is a valid response
      // (the token simply has no pools on DexScreener).
      seedQueriesFailed++;
      continue;
    }
    if (result.value.length === 0) {
      // Valid response — just no pools for this seed token; don't increment failure counter.
      continue;
    }
    seedQueriesSucceeded++;
    for (const pair of result.value) {
      const addr = pair.pairAddress?.toLowerCase();
      if (!addr) continue;
      const provider = dexIdToProviderName(pair.dexId);
      if (!provider) continue;
      const existing = poolDataMap.get(addr);
      if (!existing) {
        poolDataMap.set(addr, pair);
      }
    }
  }

  if (seedQueriesFailed > 0) {
    warnings.push(
      `${seedQueriesFailed}/${DISCOVERY_TOKENS.length} DexScreener seed-token queries failed (network/HTTP error). ` +
      `Some pools may be missing from results.`
    );
  }

  // ── Step 3: Batch-fetch registry pools not yet covered ─────────────────
  const registryAddresses = Array.from(registryByAddr.keys());
  const missingAddresses = registryAddresses.filter((a) => !poolDataMap.has(a));
  let registryBackfillFailed = 0;

  if (missingAddresses.length > 0) {
    const BATCH = 30;
    const batchPromises: Promise<boolean>[] = [];
    for (let i = 0; i < missingAddresses.length; i += BATCH) {
      const batch = missingAddresses.slice(i, i + BATCH);
      batchPromises.push(
        (async () => {
          const url = `${DEXSCREENER_API_BASE}/latest/dex/pairs/${chainId}/${batch.join(",")}`;
          const payload = await fetchJsonSafe(url);
          if (
            payload &&
            typeof payload === "object" &&
            Array.isArray(payload.pairs)
          ) {
            for (const pair of payload.pairs as DSPairForDiscovery[]) {
              const addr = pair.pairAddress?.toLowerCase();
              if (addr && !poolDataMap.has(addr)) {
                poolDataMap.set(addr, pair);
              }
            }
            return true;
          }
          return false;
        })()
      );
    }
    const backfillResults = await Promise.allSettled(batchPromises);
    for (const r of backfillResults) {
      if (r.status !== "fulfilled" || r.value === false) {
        registryBackfillFailed++;
      }
    }
    if (registryBackfillFailed > 0) {
      warnings.push(
        `${registryBackfillFailed} DexScreener batch query failed for registry pool backfill. ` +
        `Some registry pools lack TVL/volume data.`
      );
    }
  }

  // FIX-1: Compute discovery_status based on query success rates.
  let discoveryStatus: DiscoveryStatus = "complete";
  if (seedQueriesSucceeded === 0) {
    discoveryStatus = "degraded";
    warnings.push(
      "All DexScreener queries failed. Results are limited to registry pools without market data."
    );
  } else if (seedQueriesFailed > 0 || registryBackfillFailed > 0) {
    discoveryStatus = "partial";
  }

  // ── Step 4a: Read fee() on-chain for V3 pools ─────────────────────────
  // Discovered V3 pools need fee() read. Registry V3 pools already have
  // fee_tier so they are authoritative.
  const needV3FeeRead: Array<{ addr: string; poolAddr: `0x${string}` }> = [];
  for (const [addr] of poolDataMap) {
    if (!registryByAddr.has(addr)) {
      const pair = poolDataMap.get(addr)!;
      const provider = dexIdToProviderName(pair.dexId);
      if (provider === "agni" || provider === "fluxion") {
        needV3FeeRead.push({
          addr,
          poolAddr: (pair.pairAddress ?? addr) as `0x${string}`
        });
      }
    }
  }

  const v3FeeByAddr = new Map<string, number>();
  if (needV3FeeRead.length > 0) {
    const feeCalls = needV3FeeRead.map((item) => ({
      address: item.poolAddr,
      abi: V3_FEE_READ_ABI,
      functionName: "fee" as const
    }));
    try {
      const feeResults = await client.multicall({ contracts: feeCalls });
      for (let i = 0; i < needV3FeeRead.length; i++) {
        const result = feeResults[i];
        if (result.status === "success" && typeof result.result === "number") {
          v3FeeByAddr.set(needV3FeeRead[i].addr, result.result);
        }
      }
    } catch {
      warnings.push("V3 fee multicall failed; discovered V3 pool APR will be unavailable.");
    }
  }

  // ── Step 4b: Read getStaticFeeParameters() on-chain for ALL LB pools ──
  // FIX-2: Read authoritative baseFactor from chain instead of guessing.
  // baseFee (as fraction) = baseFactor * binStep * 1e-8
  // baseFee (as %) = baseFactor * binStep / 1e6
  const lbPoolsToRead: Array<{
    addr: string;
    poolAddr: `0x${string}`;
    binStep: number | null;
  }> = [];

  for (const [addr, data] of poolDataMap) {
    const reg = registryByAddr.get(addr);
    const provider = reg?.provider ?? dexIdToProviderName(data.dexId);
    if (provider === "merchant_moe") {
      lbPoolsToRead.push({
        addr,
        poolAddr: (data.pairAddress ?? addr) as `0x${string}`,
        binStep: reg?.bin_step ?? null
      });
    }
  }

  // We also need binStep for discovered LB pools (not in registry).
  // Read both getStaticFeeParameters and getBinStep in one multicall.
  const lbFeeByAddr = new Map<string, { feeRatePct: number; binStep: number }>();
  if (lbPoolsToRead.length > 0) {
    const lbCalls: Array<{
      address: `0x${string}`;
      abi: typeof LB_STATIC_FEE_PARAMS_ABI | typeof LB_PAIR_ABI;
      functionName: string;
    }> = [];
    // For each pool: [getStaticFeeParameters, getBinStep]
    for (const item of lbPoolsToRead) {
      lbCalls.push({
        address: item.poolAddr,
        abi: LB_STATIC_FEE_PARAMS_ABI,
        functionName: "getStaticFeeParameters" as const
      });
      lbCalls.push({
        address: item.poolAddr,
        abi: LB_PAIR_ABI,
        functionName: "getBinStep" as const
      });
    }
    try {
      const lbResults = await client.multicall({ contracts: lbCalls as any });
      for (let i = 0; i < lbPoolsToRead.length; i++) {
        const feeResult = lbResults[i * 2];
        const binStepResult = lbResults[i * 2 + 1];

        if (feeResult.status === "success" && feeResult.result) {
          // getStaticFeeParameters returns a tuple; baseFactor is the first element.
          const resultArr = feeResult.result as readonly [number, ...unknown[]];
          const baseFactor = Number(resultArr[0]);

          // Resolve binStep: prefer on-chain, fall back to registry
          let binStep = lbPoolsToRead[i].binStep;
          if (
            binStepResult.status === "success" &&
            typeof binStepResult.result === "number"
          ) {
            binStep = binStepResult.result;
          }

          if (binStep != null && baseFactor > 0) {
            // baseFee (fraction) = baseFactor * binStep * 1e-8
            // baseFee (%) = baseFactor * binStep / 1e6
            const feeRatePct = (baseFactor * binStep) / 1_000_000;
            lbFeeByAddr.set(lbPoolsToRead[i].addr, { feeRatePct, binStep });
          }
        }
      }
    } catch {
      warnings.push(
        "LB fee parameters multicall failed; Merchant Moe pool APR will be unavailable."
      );
    }
  }

  // ── Step 5: Build unified pool list ────────────────────────────────────
  const topPools: TopPoolEntry[] = [];

  for (const [addr, data] of poolDataMap) {
    const reg = registryByAddr.get(addr);
    const tvl = asFiniteNumber(data.liquidity?.usd);
    const volume = asFiniteNumber(data.volume?.h24);
    const priceChange = asFiniteNumber(data.priceChange?.h24);

    let provider: string;
    let feeRatePct: number;
    let feeVerified = false;
    let feeTier: number | undefined;
    let binStep: number | undefined;
    let tokenASymbol: string;
    let tokenBSymbol: string;
    let tokenAAddr: string;
    let tokenBAddr: string;

    if (reg) {
      // Known pool from registry
      provider = reg.provider;
      feeTier = reg.fee_tier;
      binStep = reg.bin_step;

      // FIX-3: Use registry addresses — never DexScreener's base/quote ordering.
      tokenASymbol = reg.tokenA;
      tokenBSymbol = reg.tokenB;
      tokenAAddr = reg.tokenAAddress;
      tokenBAddr = reg.tokenBAddress;

      // FIX-2: Use authoritative fee data.
      if (provider === "merchant_moe") {
        const lbFee = lbFeeByAddr.get(addr);
        if (lbFee) {
          feeRatePct = lbFee.feeRatePct;
          binStep = lbFee.binStep;
          feeVerified = true;
        } else {
          // Chain read failed — APR cannot be verified
          feeRatePct = 0;
          feeVerified = false;
        }
      } else {
        // V3 registry pools have authoritative fee_tier
        feeRatePct = feeTier != null ? (feeTier / 1_000_000) * 100 : 0;
        feeVerified = feeTier != null;
      }
    } else {
      // Discovered pool — infer from DexScreener data + on-chain reads
      provider = dexIdToProviderName(data.dexId) ?? data.dexId ?? "unknown";

      tokenASymbol = data.baseToken?.symbol ?? "?";
      tokenBSymbol = data.quoteToken?.symbol ?? "?";
      tokenAAddr = data.baseToken?.address ?? "";
      tokenBAddr = data.quoteToken?.address ?? "";

      if (provider === "merchant_moe") {
        const lbFee = lbFeeByAddr.get(addr);
        if (lbFee) {
          feeRatePct = lbFee.feeRatePct;
          binStep = lbFee.binStep;
          feeVerified = true;
        } else {
          feeRatePct = 0;
          feeVerified = false;
        }
      } else {
        // V3 discovered pool — use on-chain fee if available
        const onChainFee = v3FeeByAddr.get(addr);
        if (onChainFee != null) {
          feeTier = onChainFee;
          feeRatePct = (onChainFee / 1_000_000) * 100;
          feeVerified = true;
        } else {
          feeRatePct = 0;
          feeVerified = false;
        }
      }
    }

    // Apply filters
    if (providerFilter && !provider.toLowerCase().includes(providerFilter)) {
      continue;
    }
    if (tvl != null && tvl < minTvl) continue;
    // Skip pools with zero volume AND zero TVL (dead pools)
    if ((volume == null || volume === 0) && (tvl == null || tvl === 0)) {
      continue;
    }

    // Calculate fee APR: (volume_24h × fee_rate × 365) / TVL
    // FIX-2: Only compute APR when fee is verified. Otherwise null.
    const feeAprPct =
      feeVerified && volume != null && tvl != null && tvl > 0
        ? ((volume * (feeRatePct / 100) * 365) / tvl) * 100
        : null;

    topPools.push({
      rank: 0, // filled after sort
      pool_address: data.pairAddress ?? addr,
      provider,
      token_a: { symbol: tokenASymbol, address: tokenAAddr },
      token_b: { symbol: tokenBSymbol, address: tokenBAddr },
      fee_tier: feeTier,
      fee_rate_pct: feeVerified ? Math.round(feeRatePct * 10000) / 10000 : 0,
      fee_verified: feeVerified,
      bin_step: binStep,
      tvl_usd: tvl != null ? Math.round(tvl) : null,
      volume_24h_usd: volume != null ? Math.round(volume) : null,
      fee_apr_pct:
        feeAprPct != null ? Math.round(feeAprPct * 100) / 100 : null,
      apr_verified: feeVerified && feeAprPct != null,
      price_change_24h_pct: priceChange,
      source: reg ? "registry" : "discovered"
    });
  }

  // ── Step 6: Sort ───────────────────────────────────────────────────────
  // FIX-2: When sorting by APR, pools without verified APR sink to bottom.
  topPools.sort((a, b) => {
    if (sortBy === "apr") {
      // Verified APR pools always rank above unverified
      if (a.apr_verified && !b.apr_verified) return -1;
      if (!a.apr_verified && b.apr_verified) return 1;
      return (b.fee_apr_pct ?? -1) - (a.fee_apr_pct ?? -1);
    } else if (sortBy === "tvl") {
      return (b.tvl_usd ?? -1) - (a.tvl_usd ?? -1);
    } else {
      // Default: sort by 24h volume
      return (b.volume_24h_usd ?? -1) - (a.volume_24h_usd ?? -1);
    }
  });

  // Assign ranks & trim
  const result = topPools.slice(0, limit);
  result.forEach((p, i) => {
    p.rank = i + 1;
  });

  const registryPoolsEnriched = registryAddresses.filter((a) =>
    poolDataMap.has(a)
  ).length;

  return {
    top_pools: result,
    total_scanned: poolDataMap.size,
    total_with_activity: topPools.length,
    sort_by: sortBy,
    // FIX-1: Expose discovery_status so callers know if results are complete.
    discovery_status: discoveryStatus,
    filters_applied: {
      min_tvl_usd: minTvl,
      provider: providerFilter,
      limit
    },
    discovery_sources: {
      registry_pools_total: registryByAddr.size,
      registry_pools_enriched: registryPoolsEnriched,
      dexscreener_discovered: poolDataMap.size - registryAddresses.filter((a) => poolDataMap.has(a)).length,
      seed_queries: {
        succeeded: seedQueriesSucceeded,
        failed: seedQueriesFailed,
        total: DISCOVERY_TOKENS.length
      }
    },
    warnings: warnings.length > 0 ? warnings : undefined,
    note:
      "Fee APR is calculated as (24h_volume × fee_rate × 365 / TVL). " +
      "Only pools with fee_verified=true have authoritative APR. " +
      "Actual returns depend on liquidity concentration range, price movement, " +
      "impermanent loss, and rebalancing costs. Concentrated positions earn " +
      "multiples of the base APR shown here.",
    queried_at_utc: nowUtc()
  };
}

// =========================================================================
// Tool 8: mantle_getLBPositions
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
      "Read on-chain state of a Merchant Moe Liquidity Book pair on Mantle. Returns active bin ID, bin step, token metadata, active bin reserves, and reserves for +-5 nearby bins.\n\nResolve by pair_address directly, or by (token_a + token_b + bin_step) to look up via the LB Factory.\n\nExamples:\n- By address: pair_address='<pair_address>'\n- By pair: token_a='WMNT', token_b='USDC', bin_step=25",
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

  // mantle_getV3Positions: re-enabled with Transfer-event log scanning to
  // work around Agni's missing ERC721Enumerable. See discoverTokenIdsByEvents
  // in this file. Partial scan failures surface as `warnings[]` in the result.
  mantle_getV3Positions: {
    name: "mantle_getV3Positions",
    description:
      "List Uniswap V3-compatible LP positions (Agni Finance or Fluxion) owned by an address on Mantle. For each position returns token_id, both tokens with metadata, fee tier, tick bounds, liquidity, uncollected fees (tokens_owed0/1), and whether the current price is in range.\n\nFalls back to Transfer event log scanning when the position manager does not implement ERC721Enumerable (Agni). Partial scan failures are surfaced via the optional `warnings` field — agents should check it.\n\nExamples:\n- All providers: owner='0x...'\n- Single provider: owner='0x...', provider='agni'\n- Include zero-liquidity NFTs (e.g. burned positions): include_empty=true",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Wallet address to query for V3 positions."
        },
        provider: {
          type: "string",
          description:
            "DEX provider: 'agni' or 'fluxion'. Omit to scan both."
        },
        include_empty: {
          type: "boolean",
          description:
            "When true, include positions with zero liquidity AND zero uncollected fees. Default false."
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
      "Discover available liquidity pools on Mantle across all indexed DEXes (Agni, Fluxion, Merchant Moe) from a local, periodically-refreshed snapshot. Returns every pool with its fee tier / bin step, liquidity, and DexScreener market data (TVL, 24h volume, fee APR).\n\n" +
      "TWO MODES:\n" +
      "- PAIR MODE (both token_a AND token_b provided): returns every indexed pool for that specific pair across all fee tiers / bin steps.\n" +
      "- SINGLE-SIDE MODE (only one of token_a OR token_b provided): returns every pool that involves the given token, regardless of whether it is the pool's token0/tokenX or token1/tokenY. Counterparts are enumerated from three independent LOCAL sources — the bundled DexScreener pool snapshot (`config/dexscreener-pools.json`), the curated static pair registry, and every token in the Mantle registry — so no pool is missed. Per-pool `token_a`/`token_b` identify the actual counterpart for each pool.\n\n" +
      "POOL RECOMMENDATION: Returns a `recommended_pool` field — the pool with the highest composite score " +
      "(TVL × 0.6 + volume × 0.4). Always prefer the recommended pool when adding LP unless the user has a specific preference.\n\n" +
      "This is the authoritative pool discovery tool. It is zero-RPC and millisecond-fast: pool addresses, fee tiers, and bin steps come from the local snapshot (regenerated out-of-band via `scripts/refresh-pools.mjs`, liquidity ≥ $1000, on-chain verified). Live DexScreener is still called to enrich TVL/volume/APR on the discovered pools.\n\n" +
      "Pool output fields:\n" +
      "- token_a / token_b (per pool): the actual token pair for that pool (anchor first in single-side mode, input order in pair mode). Factory lookups are symmetric so on-chain token0/token1 ordering may differ — use these for 'is FBTC tokenA or tokenB?' only as an informational label.\n" +
      "- liquidity_raw / liquidity_unit: snapshot USD liquidity floored to an integer string; unit is \"dexscreener_usd_snapshot\" for all pools from the new discovery path.\n" +
      "- tvl_usd: Total Value Locked in USD (from DexScreener, live)\n" +
      "- volume_24h_usd: 24-hour trading volume in USD\n" +
      "- fee_apr_pct: Estimated fee APR based on volume/TVL\n\n" +
      "Examples:\n" +
      "- Find USDC/USDe pools (pair mode): token_a='USDC', token_b='USDe'\n" +
      "- Find all FBTC pools (single-side mode): token_a='FBTC' (omit token_b) — returns FBTC/WMNT, FBTC/USDT, … across all DEXes.\n" +
      "- Equivalent single-side: token_b='FBTC' (omit token_a) — identical result, same pools.",
    inputSchema: {
      type: "object",
      properties: {
        token_a: {
          type: "string",
          description:
            "First token symbol or address. Optional — provide only this (and omit token_b) to run single-side discovery: every pool involving this token on any DEX is returned. Provide with token_b for a pair query."
        },
        token_b: {
          type: "string",
          description:
            "Second token symbol or address. Optional — provide only this (and omit token_a) to run single-side discovery. Provide with token_a for a pair query. At least one of token_a / token_b is required."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: []
    },
    handler: findPools
  },

  // mantle_discoverTopPools — temporarily disabled (DexScreener rate-limit issues)
  // Re-enable once rate-limit / retry logic is hardened.

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
      "FIELD USAGE for LP removal:\n" +
      "- balance_raw: the ERC-1155 LP share token count from balanceOf(). USE THIS as 'amounts' in mantle_buildRemoveLiquidity.\n" +
      "- user_amount_x_raw / user_amount_y_raw: estimated underlying token amounts (pro-rata of reserves). For DISPLAY/VALUATION only — do NOT pass these as 'amounts' to removeLiquidity.\n" +
      "- RECOMMENDED: use percentage mode in mantle_buildRemoveLiquidity instead of manually extracting balance_raw values.\n\n" +
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
