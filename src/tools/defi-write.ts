/**
 * DeFi Write Tools — construct unsigned transaction calldata for whitelisted
 * DeFi operations on Mantle.
 *
 * SAFETY: These tools NEVER hold private keys, sign, or broadcast transactions.
 * Every tool returns an `unsigned_tx` payload that the caller must sign externally.
 */

import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits
} from "viem";

import { MantleMcpError } from "../errors.js";
import { getPublicClient } from "../lib/clients.js";
import { ERC20_ABI } from "../lib/erc20.js";
import { normalizeNetwork } from "../lib/network.js";
import {
  resolveTokenInput as resolveTokenInputFromRegistry,
  type ResolvedTokenInput
} from "../lib/token-registry.js";
import {
  MANTLE_PROTOCOLS,
  isWhitelistedContract,
  whitelistLabel
} from "../config/protocols.js";
import type { Tool, Network } from "../types.js";
import { CHAIN_CONFIGS } from "../config/chains.js";
import {
  findReserveBySymbol,
  findReserveByUnderlying,
  aaveReserveSymbols,
  type AaveReserveAsset
} from "../config/aave-reserves.js";
import {
  findPair,
  findPairByAddress,
  listPairs,
  listAllPairs,
  type DexPair,
  type MoePair,
  type V3Pair
} from "../config/dex-pairs.js";

// ABIs
import { WMNT_ABI } from "../lib/abis/wmnt.js";
import { V3_SWAP_ROUTER_ABI, V3_POSITION_MANAGER_ABI } from "../lib/abis/uniswap-v3.js";
import { LB_ROUTER_ABI, MOE_ROUTER_ABI } from "../lib/abis/merchant-moe-lb.js";
import { AAVE_V3_POOL_ABI, AAVE_V3_WETH_GATEWAY_ABI } from "../lib/abis/aave-v3-pool.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DEADLINE_SECONDS = 1200; // 20 minutes
const MAX_UINT256 = 2n ** 256n - 1n;

/** Derive chain ID from network config instead of hardcoding. */
function chainId(network: Network): number {
  return CHAIN_CONFIGS[network].chain_id;
}

/** Derive WMNT address from network config instead of hardcoding. */
function wmntAddress(network: Network): string {
  return CHAIN_CONFIGS[network].wrapped_mnt;
}

/**
 * Resolve an Aave reserve by symbol or underlying address.
 * Throws if the asset is not a supported Aave V3 reserve on Mantle.
 */
function requireAaveReserve(symbolOrAddress: string): AaveReserveAsset {
  const reserve =
    findReserveBySymbol(symbolOrAddress) ??
    findReserveByUnderlying(symbolOrAddress);
  if (!reserve) {
    throw new MantleMcpError(
      "UNSUPPORTED_AAVE_ASSET",
      `'${symbolOrAddress}' is not a supported Aave V3 reserve on Mantle.`,
      `Supported assets: ${aaveReserveSymbols().join(", ")}.`,
      { asset: symbolOrAddress, supported: aaveReserveSymbols() }
    );
  }
  return reserve;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface DefiWriteDeps {
  getClient: (network: Network) => ReturnType<typeof getPublicClient>;
  resolveTokenInput: (
    token: string,
    network?: Network
  ) => Promise<ResolvedTokenInput> | ResolvedTokenInput;
  now: () => string;
  deadline: () => bigint;
}

const defaultDeps: DefiWriteDeps = {
  getClient: getPublicClient,
  resolveTokenInput: (token, network) =>
    resolveTokenInputFromRegistry(token, network ?? "mainnet"),
  now: () => new Date().toISOString(),
  deadline: () =>
    BigInt(Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SECONDS)
};

function withDeps(overrides?: Partial<DefiWriteDeps>): DefiWriteDeps {
  return { ...defaultDeps, ...overrides };
}

function requireAddress(input: unknown, fieldName: string): string {
  if (typeof input !== "string" || !isAddress(input, { strict: false })) {
    throw new MantleMcpError(
      "INVALID_ADDRESS",
      `${fieldName} must be a valid address.`,
      "Provide an EIP-55 address string.",
      { field: fieldName, value: input ?? null }
    );
  }
  return getAddress(input);
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

/** Resolved token with guaranteed non-null decimals. */
interface ResolvedToken {
  address: string;
  symbol: string;
  decimals: number;
}

async function resolveToken(
  d: DefiWriteDeps,
  input: string,
  network: Network
): Promise<ResolvedToken> {
  const resolved = await d.resolveTokenInput(input, network);
  if (resolved.decimals == null) {
    throw new MantleMcpError(
      "TOKEN_NOT_FOUND",
      `Cannot determine decimals for token '${input}'. Provide a known symbol or token address from the Mantle token list.`,
      "Use a well-known token symbol (WMNT, USDC, USDT, USDe, mETH) or a verified address.",
      { token: input }
    );
  }
  return {
    address: resolved.address,
    symbol: resolved.symbol ?? resolved.address,
    decimals: resolved.decimals
  };
}

function requirePositiveAmount(
  input: unknown,
  fieldName: string,
  decimals: number
): bigint {
  const str = requireString(input, fieldName);
  let parsed: bigint;
  try {
    parsed = parseUnits(str, decimals);
  } catch {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `${fieldName} is not a valid decimal number.`,
      "Provide a positive decimal amount (e.g. '1.5').",
      { field: fieldName, value: str }
    );
  }
  if (parsed <= 0n) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `${fieldName} must be greater than zero.`,
      "Provide a positive amount.",
      { field: fieldName, value: str }
    );
  }
  return parsed;
}

type DexProvider = "agni" | "fluxion" | "merchant_moe";

function requireProvider(input: unknown): DexProvider {
  const str = typeof input === "string" ? input.toLowerCase().trim() : "";
  const valid: DexProvider[] = ["agni", "fluxion", "merchant_moe"];
  if (!valid.includes(str as DexProvider)) {
    throw new MantleMcpError(
      "UNSUPPORTED_PROTOCOL",
      `Unsupported provider: ${String(input)}`,
      "Use one of: agni, fluxion, merchant_moe.",
      { provider: input ?? null }
    );
  }
  return str as DexProvider;
}

function getContractAddress(
  protocol: string,
  contractKey: string,
  network: Network
): string {
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
  return addr;
}

interface UnsignedTxResult {
  intent: string;
  human_summary: string;
  unsigned_tx: {
    to: string;
    data: string;
    value: string;
    chainId: number;
  };
  warnings: string[];
  built_at_utc: string;
  /** Present on Aave operations — the reserve's aToken and debt token. */
  aave_reserve?: {
    symbol: string;
    underlying: string;
    aToken: string;
    variableDebtToken: string;
    decimals: number;
  };
}

// =========================================================================
// Tool 1: mantle_buildApprove
// =========================================================================

export async function buildApprove(
  args: Record<string, unknown>,
  deps?: Partial<DefiWriteDeps>
): Promise<UnsignedTxResult> {
  const d = withDeps(deps);
  const { network } = normalizeNetwork(args);

  const spender = requireAddress(args.spender, "spender");
  const tokenInput = requireString(args.token, "token");
  const resolved = await resolveToken(d, tokenInput, network);
  const amountRaw = args.amount === "max" || args.amount === "unlimited"
    ? MAX_UINT256
    : requirePositiveAmount(args.amount, "amount", resolved.decimals);

  // Whitelist enforcement
  if (!isWhitelistedContract(spender, network)) {
    throw new MantleMcpError(
      "SPENDER_NOT_WHITELISTED",
      `Spender ${spender} is not a whitelisted contract.`,
      "Only whitelisted protocol contracts can be approved as spenders.",
      { spender, network }
    );
  }

  const spenderLabel = whitelistLabel(spender, network) ?? spender;
  const amountDecimal =
    amountRaw === MAX_UINT256
      ? "unlimited"
      : formatUnits(amountRaw, resolved.decimals);

  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender as `0x${string}`, amountRaw]
  });

  const warnings: string[] = [];
  if (amountRaw === MAX_UINT256) {
    warnings.push(
      "Unlimited approval granted. Consider using exact amounts for better security."
    );
  }

  return {
    intent: "approve",
    human_summary: `Approve ${amountDecimal} ${resolved.symbol} for ${spenderLabel}`,
    unsigned_tx: {
      to: resolved.address,
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings,
    built_at_utc: d.now()
  };
}

// =========================================================================
// Tool 2: mantle_buildWrapMnt
// =========================================================================

export async function buildWrapMnt(
  args: Record<string, unknown>,
  deps?: Partial<DefiWriteDeps>
): Promise<UnsignedTxResult> {
  const d = withDeps(deps);
  const { network } = normalizeNetwork(args);

  const amountRaw = requirePositiveAmount(args.amount, "amount", 18);
  const amountDecimal = formatUnits(amountRaw, 18);

  const data = encodeFunctionData({
    abi: WMNT_ABI,
    functionName: "deposit"
  });

  return {
    intent: "wrap_mnt",
    human_summary: `Wrap ${amountDecimal} MNT → WMNT`,
    unsigned_tx: {
      to: wmntAddress(network),
      data,
      value: "0x" + amountRaw.toString(16),
      chainId: chainId(network)
    },
    warnings: [],
    built_at_utc: d.now()
  };
}

// =========================================================================
// Tool 3: mantle_buildUnwrapMnt
// =========================================================================

export async function buildUnwrapMnt(
  args: Record<string, unknown>,
  deps?: Partial<DefiWriteDeps>
): Promise<UnsignedTxResult> {
  const d = withDeps(deps);
  const { network } = normalizeNetwork(args);

  const amountRaw = requirePositiveAmount(args.amount, "amount", 18);
  const amountDecimal = formatUnits(amountRaw, 18);

  const data = encodeFunctionData({
    abi: WMNT_ABI,
    functionName: "withdraw",
    args: [amountRaw]
  });

  return {
    intent: "unwrap_mnt",
    human_summary: `Unwrap ${amountDecimal} WMNT → MNT`,
    unsigned_tx: {
      to: wmntAddress(network),
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings: [],
    built_at_utc: d.now()
  };
}

// =========================================================================
// Tool 4: mantle_buildSwap
// =========================================================================

export async function buildSwap(
  args: Record<string, unknown>,
  deps?: Partial<DefiWriteDeps>
): Promise<UnsignedTxResult> {
  const d = withDeps(deps);
  const { network } = normalizeNetwork(args);
  const provider = requireProvider(args.provider);

  const tokenInInput = requireString(args.token_in, "token_in");
  const tokenOutInput = requireString(args.token_out, "token_out");
  const tokenIn = await resolveToken(d, tokenInInput, network);
  const tokenOut = await resolveToken(d, tokenOutInput, network);
  const amountInRaw = requirePositiveAmount(
    args.amount_in,
    "amount_in",
    tokenIn.decimals
  );

  const slippageBps =
    typeof args.slippage_bps === "number" ? args.slippage_bps : 50; // default 0.5%
  const recipient = requireAddress(args.recipient, "recipient");

  // Auto-resolve pair params from known pairs registry
  const knownPair =
    findPair(provider, tokenIn.symbol, tokenOut.symbol, network) ??
    findPairByAddress(provider, tokenIn.address, tokenOut.address, network);

  // Accept caller-provided amount_out_min (from a prior quote call)
  const amountOutMin =
    typeof args.amount_out_min === "string" && args.amount_out_min !== "0"
      ? BigInt(args.amount_out_min)
      : 0n;

  const amountInDecimal = formatUnits(amountInRaw, tokenIn.decimals);
  const deadline = d.deadline();

  if (provider === "agni" || provider === "fluxion") {
    // Resolve fee_tier: caller > known pair > error
    let feeTier: number;
    if (typeof args.fee_tier === "number") {
      feeTier = args.fee_tier;
    } else if (knownPair && knownPair.provider !== "merchant_moe") {
      feeTier = (knownPair as V3Pair).feeTier;
    } else {
      const available = listPairs(provider).map(
        (p) => `${p.tokenA}/${p.tokenB}`
      );
      throw new MantleMcpError(
        "UNKNOWN_PAIR",
        `No known fee_tier for ${tokenIn.symbol}/${tokenOut.symbol} on ${provider}. Provide fee_tier explicitly.`,
        `Known pairs on ${provider}: ${available.join(", ") || "none"}. Common fee tiers: 500 (0.05%), 3000 (0.3%), 10000 (1%).`,
        { provider, tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol }
      );
    }

    return buildV3Swap({
      provider,
      tokenIn,
      tokenOut,
      amountInRaw,
      amountInDecimal,
      amountOutMin,
      slippageBps,
      recipient,
      deadline,
      network,
      feeTier,
      now: d.now()
    });
  }

  // merchant_moe — resolve bin_step: caller > known pair > error
  let binStep: number;
  if (typeof args.bin_step === "number") {
    binStep = args.bin_step;
  } else if (knownPair && knownPair.provider === "merchant_moe") {
    binStep = (knownPair as MoePair).binStep;
  } else {
    const available = listPairs("merchant_moe").map(
      (p) => `${p.tokenA}/${p.tokenB}`
    );
    throw new MantleMcpError(
      "UNKNOWN_PAIR",
      `No known bin_step for ${tokenIn.symbol}/${tokenOut.symbol} on Merchant Moe. Provide bin_step explicitly.`,
      `Known pairs on Merchant Moe: ${available.join(", ")}. Common bin steps: 1 (stablecoins), 5 (LSTs), 20 (volatile).`,
      { provider, tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol }
    );
  }

  return buildMoeSwap({
    tokenIn,
    tokenOut,
    amountInRaw,
    amountInDecimal,
    amountOutMin,
    slippageBps,
    recipient,
    deadline,
    network,
    binStep,
    now: d.now()
  });
}

function buildV3Swap(params: {
  provider: "agni" | "fluxion";
  tokenIn: ResolvedToken;
  tokenOut: ResolvedToken;
  amountInRaw: bigint;
  amountInDecimal: string;
  amountOutMin: bigint;
  slippageBps: number;
  recipient: string;
  deadline: bigint;
  network: Network;
  feeTier: number;
  now: string;
}): UnsignedTxResult {
  const {
    provider,
    tokenIn,
    tokenOut,
    amountInRaw,
    amountInDecimal,
    amountOutMin,
    slippageBps,
    recipient,
    deadline,
    network,
    feeTier,
    now
  } = params;

  const routerAddress = getContractAddress(provider, "swap_router", network);

  // Use amountOutMin from caller (ideally from a prior quote call)

  const data = encodeFunctionData({
    abi: V3_SWAP_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: tokenIn.address as `0x${string}`,
        tokenOut: tokenOut.address as `0x${string}`,
        fee: feeTier,
        recipient: recipient as `0x${string}`,
        deadline,
        amountIn: amountInRaw,
        amountOutMinimum: amountOutMin,
        sqrtPriceLimitX96: 0n
      }
    ]
  });

  const warnings: string[] = [];
  if (amountOutMin === 0n) {
    warnings.push(
      `amountOutMinimum is 0. Call mantle_getSwapQuote first and pass amount_out_min to avoid sandwich attacks.`
    );
  }

  const providerLabel = provider === "agni" ? "Agni" : "Fluxion";
  return {
    intent: "swap",
    human_summary: `Swap ${amountInDecimal} ${tokenIn.symbol} → ${tokenOut.symbol} on ${providerLabel} (fee tier: ${feeTier / 10000}%)`,
    unsigned_tx: {
      to: routerAddress,
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings,
    built_at_utc: now
  };
}

function buildMoeSwap(params: {
  tokenIn: ResolvedToken;
  tokenOut: ResolvedToken;
  amountInRaw: bigint;
  amountInDecimal: string;
  amountOutMin: bigint;
  slippageBps: number;
  recipient: string;
  deadline: bigint;
  network: Network;
  binStep: number;
  now: string;
}): UnsignedTxResult {
  const {
    tokenIn,
    tokenOut,
    amountInRaw,
    amountInDecimal,
    amountOutMin,
    slippageBps,
    recipient,
    deadline,
    network,
    binStep,
    now
  } = params;

  const routerAddress = getContractAddress(
    "merchant_moe",
    "lb_router_v2_2",
    network
  );

  // LB Router path structure
  const path = {
    pairBinSteps: [BigInt(binStep)],
    versions: [2], // V2.2
    tokenPath: [
      tokenIn.address as `0x${string}`,
      tokenOut.address as `0x${string}`
    ]
  };

  const data = encodeFunctionData({
    abi: LB_ROUTER_ABI,
    functionName: "swapExactTokensForTokens",
    args: [amountInRaw, amountOutMin, path, recipient as `0x${string}`, deadline]
  });

  const warnings: string[] = [];
  warnings.push(
    `amountOutMin is 0. Call mantle_getSwapQuote first and pass the quoted minimum to avoid sandwich attacks.`
  );

  return {
    intent: "swap",
    human_summary: `Swap ${amountInDecimal} ${tokenIn.symbol} → ${tokenOut.symbol} on Merchant Moe LB (bin step: ${binStep})`,
    unsigned_tx: {
      to: routerAddress,
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings,
    built_at_utc: now
  };
}

// =========================================================================
// Tool 5: mantle_buildAddLiquidity
// =========================================================================

export async function buildAddLiquidity(
  args: Record<string, unknown>,
  deps?: Partial<DefiWriteDeps>
): Promise<UnsignedTxResult> {
  const d = withDeps(deps);
  const { network } = normalizeNetwork(args);
  const provider = requireProvider(args.provider);

  const tokenAInput = requireString(args.token_a, "token_a");
  const tokenBInput = requireString(args.token_b, "token_b");
  const tokenA = await resolveToken(d, tokenAInput, network);
  const tokenB = await resolveToken(d, tokenBInput, network);
  const amountARaw = requirePositiveAmount(
    args.amount_a,
    "amount_a",
    tokenA.decimals
  );
  const amountBRaw = requirePositiveAmount(
    args.amount_b,
    "amount_b",
    tokenB.decimals
  );
  const recipient = requireAddress(args.recipient, "recipient");
  const deadline = d.deadline();
  const slippageBps =
    typeof args.slippage_bps === "number" ? args.slippage_bps : 50;

  const amountADecimal = formatUnits(amountARaw, tokenA.decimals);
  const amountBDecimal = formatUnits(amountBRaw, tokenB.decimals);

  if (provider === "agni" || provider === "fluxion") {
    return buildV3AddLiquidity({
      provider,
      tokenA,
      tokenB,
      amountARaw,
      amountBRaw,
      amountADecimal,
      amountBDecimal,
      slippageBps,
      recipient,
      deadline,
      network,
      feeTier: typeof args.fee_tier === "number" ? args.fee_tier : 3000,
      tickLower: typeof args.tick_lower === "number" ? args.tick_lower : -887220,
      tickUpper: typeof args.tick_upper === "number" ? args.tick_upper : 887220,
      now: d.now()
    });
  }

  // merchant_moe LB
  return buildMoeAddLiquidity({
    tokenA,
    tokenB,
    amountARaw,
    amountBRaw,
    amountADecimal,
    amountBDecimal,
    slippageBps,
    recipient,
    deadline,
    network,
    binStep: typeof args.bin_step === "number" ? args.bin_step : 20,
    activeIdDesired:
      typeof args.active_id === "number" ? args.active_id : 8388608,
    idSlippage: typeof args.id_slippage === "number" ? args.id_slippage : 5,
    deltaIds: Array.isArray(args.delta_ids)
      ? (args.delta_ids as number[])
      : [0],
    distributionX: Array.isArray(args.distribution_x)
      ? (args.distribution_x as number[])
      : [1e18],
    distributionY: Array.isArray(args.distribution_y)
      ? (args.distribution_y as number[])
      : [1e18],
    now: d.now()
  });
}

function buildV3AddLiquidity(params: {
  provider: "agni" | "fluxion";
  tokenA: ResolvedToken;
  tokenB: ResolvedToken;
  amountARaw: bigint;
  amountBRaw: bigint;
  amountADecimal: string;
  amountBDecimal: string;
  slippageBps: number;
  recipient: string;
  deadline: bigint;
  network: Network;
  feeTier: number;
  tickLower: number;
  tickUpper: number;
  now: string;
}): UnsignedTxResult {
  const {
    provider,
    tokenA,
    tokenB,
    amountARaw,
    amountBRaw,
    amountADecimal,
    amountBDecimal,
    slippageBps,
    recipient,
    deadline,
    network,
    feeTier,
    tickLower,
    tickUpper,
    now
  } = params;

  const positionManager = getContractAddress(
    provider,
    "position_manager",
    network
  );

  // Sort tokens (V3 requires token0 < token1)
  const [token0, token1, amount0Desired, amount1Desired, amt0Label, amt1Label] =
    tokenA.address.toLowerCase() < tokenB.address.toLowerCase()
      ? [tokenA, tokenB, amountARaw, amountBRaw, amountADecimal, amountBDecimal]
      : [tokenB, tokenA, amountBRaw, amountARaw, amountBDecimal, amountADecimal];

  // Apply slippage to minimums
  const amount0Min =
    (amount0Desired * BigInt(10000 - slippageBps)) / 10000n;
  const amount1Min =
    (amount1Desired * BigInt(10000 - slippageBps)) / 10000n;

  const data = encodeFunctionData({
    abi: V3_POSITION_MANAGER_ABI,
    functionName: "mint",
    args: [
      {
        token0: token0.address as `0x${string}`,
        token1: token1.address as `0x${string}`,
        fee: feeTier,
        tickLower,
        tickUpper,
        amount0Desired,
        amount1Desired,
        amount0Min,
        amount1Min,
        recipient: recipient as `0x${string}`,
        deadline
      }
    ]
  });

  const providerLabel = provider === "agni" ? "Agni" : "Fluxion";
  const warnings: string[] = [];
  if (tickLower === -887220 && tickUpper === 887220) {
    warnings.push(
      "Using full-range tick bounds (MIN_TICK to MAX_TICK). Consider narrower range for concentrated liquidity."
    );
  }

  return {
    intent: "add_liquidity",
    human_summary: `Add liquidity on ${providerLabel}: ${amt0Label} ${token0.symbol} + ${amt1Label} ${token1.symbol} (fee: ${feeTier / 10000}%, ticks: [${tickLower}, ${tickUpper}])`,
    unsigned_tx: {
      to: positionManager,
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings,
    built_at_utc: now
  };
}

function buildMoeAddLiquidity(params: {
  tokenA: ResolvedToken;
  tokenB: ResolvedToken;
  amountARaw: bigint;
  amountBRaw: bigint;
  amountADecimal: string;
  amountBDecimal: string;
  slippageBps: number;
  recipient: string;
  deadline: bigint;
  network: Network;
  binStep: number;
  activeIdDesired: number;
  idSlippage: number;
  deltaIds: number[];
  distributionX: number[];
  distributionY: number[];
  now: string;
}): UnsignedTxResult {
  const {
    tokenA,
    tokenB,
    amountARaw,
    amountBRaw,
    amountADecimal,
    amountBDecimal,
    slippageBps,
    recipient,
    deadline,
    network,
    binStep,
    activeIdDesired,
    idSlippage,
    deltaIds,
    distributionX,
    distributionY,
    now
  } = params;

  const routerAddress = getContractAddress(
    "merchant_moe",
    "lb_router_v2_2",
    network
  );

  const amountAMin =
    (amountARaw * BigInt(10000 - slippageBps)) / 10000n;
  const amountBMin =
    (amountBRaw * BigInt(10000 - slippageBps)) / 10000n;

  const liquidityParameters = {
    tokenX: tokenA.address as `0x${string}`,
    tokenY: tokenB.address as `0x${string}`,
    binStep: BigInt(binStep),
    amountX: amountARaw,
    amountY: amountBRaw,
    amountXMin: amountAMin,
    amountYMin: amountBMin,
    activeIdDesired: BigInt(activeIdDesired),
    idSlippage: BigInt(idSlippage),
    deltaIds: deltaIds.map(BigInt),
    distributionX: distributionX.map((d) => BigInt(Math.floor(d))),
    distributionY: distributionY.map((d) => BigInt(Math.floor(d))),
    to: recipient as `0x${string}`,
    refundTo: recipient as `0x${string}`,
    deadline
  };

  const data = encodeFunctionData({
    abi: LB_ROUTER_ABI,
    functionName: "addLiquidity",
    args: [liquidityParameters]
  });

  return {
    intent: "add_liquidity",
    human_summary: `Add liquidity on Merchant Moe LB: ${amountADecimal} ${tokenA.symbol} + ${amountBDecimal} ${tokenB.symbol} (bin step: ${binStep})`,
    unsigned_tx: {
      to: routerAddress,
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings: [],
    built_at_utc: now
  };
}

// =========================================================================
// Tool 6: mantle_buildRemoveLiquidity
// =========================================================================

export async function buildRemoveLiquidity(
  args: Record<string, unknown>,
  deps?: Partial<DefiWriteDeps>
): Promise<UnsignedTxResult> {
  const d = withDeps(deps);
  const { network } = normalizeNetwork(args);
  const provider = requireProvider(args.provider);

  const recipient = requireAddress(args.recipient, "recipient");
  const deadline = d.deadline();

  if (provider === "agni" || provider === "fluxion") {
    return buildV3RemoveLiquidity({
      provider,
      tokenId:
        typeof args.token_id === "number"
          ? BigInt(args.token_id)
          : BigInt(requireString(args.token_id, "token_id")),
      liquidity:
        typeof args.liquidity === "string"
          ? BigInt(args.liquidity)
          : typeof args.liquidity === "number"
            ? BigInt(args.liquidity)
            : 0n,
      amount0Min: 0n,
      amount1Min: 0n,
      recipient,
      deadline,
      network,
      now: d.now()
    });
  }

  // Merchant Moe
  const tokenAInput = requireString(args.token_a, "token_a");
  const tokenBInput = requireString(args.token_b, "token_b");
  const tokenA = await resolveToken(d, tokenAInput, network);
  const tokenB = await resolveToken(d, tokenBInput, network);

  if (!Array.isArray(args.ids) || !Array.isArray(args.amounts)) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      "Merchant Moe removeLiquidity requires 'ids' and 'amounts' arrays.",
      "Provide arrays of bin IDs and corresponding amounts to remove.",
      { provider }
    );
  }

  const routerAddress = getContractAddress(
    "merchant_moe",
    "lb_router_v2_2",
    network
  );
  const binStep =
    typeof args.bin_step === "number" ? args.bin_step : 20;

  const data = encodeFunctionData({
    abi: LB_ROUTER_ABI,
    functionName: "removeLiquidity",
    args: [
      tokenA.address as `0x${string}`,
      tokenB.address as `0x${string}`,
      binStep,
      0n, // amountXMin
      0n, // amountYMin
      (args.ids as number[]).map(BigInt),
      (args.amounts as string[]).map(BigInt),
      recipient as `0x${string}`,
      deadline
    ]
  });

  return {
    intent: "remove_liquidity",
    human_summary: `Remove liquidity on Merchant Moe LB: ${tokenA.symbol}/${tokenB.symbol} (${(args.ids as number[]).length} bins)`,
    unsigned_tx: {
      to: routerAddress,
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings: [
      "amountXMin and amountYMin are 0. Consider setting minimum outputs to avoid MEV."
    ],
    built_at_utc: d.now()
  };
}

function buildV3RemoveLiquidity(params: {
  provider: "agni" | "fluxion";
  tokenId: bigint;
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  recipient: string;
  deadline: bigint;
  network: Network;
  now: string;
}): UnsignedTxResult {
  const {
    provider,
    tokenId,
    liquidity,
    amount0Min,
    amount1Min,
    recipient,
    deadline,
    network,
    now
  } = params;

  const positionManager = getContractAddress(
    provider,
    "position_manager",
    network
  );

  // V3 remove liquidity is a two-step: decreaseLiquidity + collect
  // We use multicall to batch them.
  const decreaseData = encodeFunctionData({
    abi: V3_POSITION_MANAGER_ABI,
    functionName: "decreaseLiquidity",
    args: [
      {
        tokenId,
        liquidity: BigInt(liquidity),
        amount0Min,
        amount1Min,
        deadline
      }
    ]
  });

  const collectData = encodeFunctionData({
    abi: V3_POSITION_MANAGER_ABI,
    functionName: "collect",
    args: [
      {
        tokenId,
        recipient: recipient as `0x${string}`,
        amount0Max: BigInt("340282366920938463463374607431768211455"), // uint128 max
        amount1Max: BigInt("340282366920938463463374607431768211455")
      }
    ]
  });

  const data = encodeFunctionData({
    abi: V3_POSITION_MANAGER_ABI,
    functionName: "multicall",
    args: [[decreaseData, collectData]]
  });

  const providerLabel = provider === "agni" ? "Agni" : "Fluxion";
  return {
    intent: "remove_liquidity",
    human_summary: `Remove liquidity on ${providerLabel}: position #${tokenId} (liquidity: ${liquidity})`,
    unsigned_tx: {
      to: positionManager,
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings: [
      "amount0Min and amount1Min are 0. Consider setting minimum outputs to avoid MEV."
    ],
    built_at_utc: now
  };
}

// =========================================================================
// Tool 7: mantle_buildAaveSupply
// =========================================================================

export async function buildAaveSupply(
  args: Record<string, unknown>,
  deps?: Partial<DefiWriteDeps>
): Promise<UnsignedTxResult> {
  const d = withDeps(deps);
  const { network } = normalizeNetwork(args);

  const assetInput = requireString(args.asset, "asset");
  const reserve = requireAaveReserve(assetInput);
  const asset = await resolveToken(d, reserve.underlying, network);
  const amountRaw = requirePositiveAmount(
    args.amount,
    "amount",
    asset.decimals
  );
  const onBehalfOf = requireAddress(
    args.on_behalf_of ?? args.recipient,
    "on_behalf_of"
  );

  const poolAddress = getContractAddress("aave_v3", "pool", network);
  const amountDecimal = formatUnits(amountRaw, asset.decimals);

  const data = encodeFunctionData({
    abi: AAVE_V3_POOL_ABI,
    functionName: "supply",
    args: [
      asset.address as `0x${string}`,
      amountRaw,
      onBehalfOf as `0x${string}`,
      0 // referralCode
    ]
  });

  return {
    intent: "aave_supply",
    human_summary: `Supply ${amountDecimal} ${reserve.symbol} to Aave V3 (will receive a${reserve.symbol})`,
    unsigned_tx: {
      to: poolAddress,
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings: [
      `Ensure ${reserve.symbol} is approved for the Aave Pool (${poolAddress}) before supplying.`
    ],
    aave_reserve: {
      symbol: reserve.symbol,
      underlying: reserve.underlying,
      aToken: reserve.aToken,
      variableDebtToken: reserve.variableDebtToken,
      decimals: reserve.decimals
    },
    built_at_utc: d.now()
  };
}

// =========================================================================
// Tool 8: mantle_buildAaveBorrow
// =========================================================================

export async function buildAaveBorrow(
  args: Record<string, unknown>,
  deps?: Partial<DefiWriteDeps>
): Promise<UnsignedTxResult> {
  const d = withDeps(deps);
  const { network } = normalizeNetwork(args);

  const assetInput = requireString(args.asset, "asset");
  const reserve = requireAaveReserve(assetInput);
  const asset = await resolveToken(d, reserve.underlying, network);
  const amountRaw = requirePositiveAmount(
    args.amount,
    "amount",
    asset.decimals
  );
  const onBehalfOf = requireAddress(
    args.on_behalf_of ?? args.recipient,
    "on_behalf_of"
  );
  // Interest rate mode: 2 = variable (default and recommended on V3)
  const interestRateMode =
    typeof args.interest_rate_mode === "number"
      ? args.interest_rate_mode
      : 2;

  const poolAddress = getContractAddress("aave_v3", "pool", network);
  const amountDecimal = formatUnits(amountRaw, asset.decimals);

  const data = encodeFunctionData({
    abi: AAVE_V3_POOL_ABI,
    functionName: "borrow",
    args: [
      asset.address as `0x${string}`,
      amountRaw,
      BigInt(interestRateMode),
      0, // referralCode
      onBehalfOf as `0x${string}`
    ]
  });

  const modeLabel = interestRateMode === 2 ? "variable" : "stable";
  return {
    intent: "aave_borrow",
    human_summary: `Borrow ${amountDecimal} ${reserve.symbol} from Aave V3 (${modeLabel} rate)`,
    unsigned_tx: {
      to: poolAddress,
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings: [
      "Ensure you have sufficient collateral deposited before borrowing.",
      "Monitor your health factor to avoid liquidation."
    ],
    aave_reserve: {
      symbol: reserve.symbol,
      underlying: reserve.underlying,
      aToken: reserve.aToken,
      variableDebtToken: reserve.variableDebtToken,
      decimals: reserve.decimals
    },
    built_at_utc: d.now()
  };
}

// =========================================================================
// Tool 9: mantle_buildAaveRepay
// =========================================================================

export async function buildAaveRepay(
  args: Record<string, unknown>,
  deps?: Partial<DefiWriteDeps>
): Promise<UnsignedTxResult> {
  const d = withDeps(deps);
  const { network } = normalizeNetwork(args);

  const assetInput = requireString(args.asset, "asset");
  const reserve = requireAaveReserve(assetInput);
  const asset = await resolveToken(d, reserve.underlying, network);
  const onBehalfOf = requireAddress(
    args.on_behalf_of ?? args.recipient,
    "on_behalf_of"
  );
  const interestRateMode =
    typeof args.interest_rate_mode === "number"
      ? args.interest_rate_mode
      : 2;

  // amount = "max" repays entire debt
  const amountRaw =
    args.amount === "max"
      ? MAX_UINT256
      : requirePositiveAmount(args.amount, "amount", asset.decimals);
  const amountDecimal =
    amountRaw === MAX_UINT256
      ? "max (full debt)"
      : formatUnits(amountRaw, asset.decimals);

  const poolAddress = getContractAddress("aave_v3", "pool", network);

  const data = encodeFunctionData({
    abi: AAVE_V3_POOL_ABI,
    functionName: "repay",
    args: [
      asset.address as `0x${string}`,
      amountRaw,
      BigInt(interestRateMode),
      onBehalfOf as `0x${string}`
    ]
  });

  const modeLabel = interestRateMode === 2 ? "variable" : "stable";
  return {
    intent: "aave_repay",
    human_summary: `Repay ${amountDecimal} ${reserve.symbol} to Aave V3 (${modeLabel} rate)`,
    unsigned_tx: {
      to: poolAddress,
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings: [
      `Ensure ${reserve.symbol} is approved for the Aave Pool (${poolAddress}) before repaying.`
    ],
    aave_reserve: {
      symbol: reserve.symbol,
      underlying: reserve.underlying,
      aToken: reserve.aToken,
      variableDebtToken: reserve.variableDebtToken,
      decimals: reserve.decimals
    },
    built_at_utc: d.now()
  };
}

// =========================================================================
// Tool 10: mantle_buildAaveWithdraw
// =========================================================================

export async function buildAaveWithdraw(
  args: Record<string, unknown>,
  deps?: Partial<DefiWriteDeps>
): Promise<UnsignedTxResult> {
  const d = withDeps(deps);
  const { network } = normalizeNetwork(args);

  const assetInput = requireString(args.asset, "asset");
  const reserve = requireAaveReserve(assetInput);
  const asset = await resolveToken(d, reserve.underlying, network);
  const to = requireAddress(args.to ?? args.recipient, "to");

  const amountRaw =
    args.amount === "max"
      ? MAX_UINT256
      : requirePositiveAmount(args.amount, "amount", asset.decimals);
  const amountDecimal =
    amountRaw === MAX_UINT256
      ? "max (full balance)"
      : formatUnits(amountRaw, asset.decimals);

  const poolAddress = getContractAddress("aave_v3", "pool", network);

  const data = encodeFunctionData({
    abi: AAVE_V3_POOL_ABI,
    functionName: "withdraw",
    args: [
      asset.address as `0x${string}`,
      amountRaw,
      to as `0x${string}`
    ]
  });

  return {
    intent: "aave_withdraw",
    human_summary: `Withdraw ${amountDecimal} ${reserve.symbol} from Aave V3`,
    unsigned_tx: {
      to: poolAddress,
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings: [
      "Withdrawing collateral may lower your health factor. Check before proceeding."
    ],
    aave_reserve: {
      symbol: reserve.symbol,
      underlying: reserve.underlying,
      aToken: reserve.aToken,
      variableDebtToken: reserve.variableDebtToken,
      decimals: reserve.decimals
    },
    built_at_utc: d.now()
  };
}

// =========================================================================
// Tool 11: mantle_getSwapPairs (read-only — returns known pair configs)
// =========================================================================

export async function getSwapPairs(
  args: Record<string, unknown>
): Promise<unknown> {
  const providerRaw = typeof args.provider === "string" ? args.provider.toLowerCase().trim() : null;
  const validProviders = ["agni", "fluxion", "merchant_moe"] as const;

  if (providerRaw && validProviders.includes(providerRaw as typeof validProviders[number])) {
    const pairs = listPairs(providerRaw as typeof validProviders[number]);
    return {
      provider: providerRaw,
      pairs: pairs.map((p) => ({
        tokenA: p.tokenA,
        tokenB: p.tokenB,
        pool: p.pool,
        ...(p.provider === "merchant_moe"
          ? { bin_step: (p as MoePair).binStep, version: (p as MoePair).version }
          : { fee_tier: (p as V3Pair).feeTier })
      })),
      count: pairs.length
    };
  }

  // Return all pairs grouped by provider
  const all = listAllPairs();
  const grouped: Record<string, unknown[]> = {};
  for (const p of all) {
    if (!grouped[p.provider]) grouped[p.provider] = [];
    grouped[p.provider].push({
      tokenA: p.tokenA,
      tokenB: p.tokenB,
      pool: p.pool,
      ...(p.provider === "merchant_moe"
        ? { bin_step: (p as MoePair).binStep }
        : { fee_tier: (p as V3Pair).feeTier })
    });
  }
  return { pairs_by_provider: grouped, total: all.length };
}

// =========================================================================
// Tool definitions (MCP schema)
// =========================================================================

export const defiWriteTools: Record<string, Tool> = {
  mantle_buildApprove: {
    name: "mantle_buildApprove",
    description:
      "Build an unsigned ERC-20 approve transaction. Validates that the spender is a whitelisted DeFi protocol contract. Returns calldata — does NOT sign or broadcast.\n\nExamples:\n- Approve WMNT for Agni SwapRouter: token='WMNT', spender='0x319B69888b0d11cEC22caA5034e25FfFBDc88421', amount='100'\n- Unlimited approve USDC for Aave Pool: token='USDC', spender='0x458F293454fE0d67EC0655f3672301301DD51422', amount='max'",
    inputSchema: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description: "Token symbol (e.g. 'WMNT', 'USDC') or address."
        },
        spender: {
          type: "string",
          description:
            "Address of the contract to approve (must be on the whitelist)."
        },
        amount: {
          type: "string",
          description:
            "Decimal amount to approve (e.g. '100'). Use 'max' for unlimited."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["token", "spender", "amount"]
    },
    handler: buildApprove
  },

  mantle_buildWrapMnt: {
    name: "mantle_buildWrapMnt",
    description:
      "Build an unsigned transaction to wrap MNT into WMNT. Returns calldata with value field set to the wrap amount.\n\nExamples:\n- Wrap 10 MNT: amount='10'\n- Wrap 0.5 MNT: amount='0.5'",
    inputSchema: {
      type: "object",
      properties: {
        amount: {
          type: "string",
          description: "Decimal amount of MNT to wrap (e.g. '10')."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["amount"]
    },
    handler: buildWrapMnt
  },

  mantle_buildUnwrapMnt: {
    name: "mantle_buildUnwrapMnt",
    description:
      "Build an unsigned transaction to unwrap WMNT back to MNT.\n\nExamples:\n- Unwrap 10 WMNT: amount='10'\n- Unwrap 0.5 WMNT: amount='0.5'",
    inputSchema: {
      type: "object",
      properties: {
        amount: {
          type: "string",
          description: "Decimal amount of WMNT to unwrap (e.g. '10')."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["amount"]
    },
    handler: buildUnwrapMnt
  },

  mantle_buildSwap: {
    name: "mantle_buildSwap",
    description:
      "Build an unsigned swap transaction on a whitelisted DEX. Pool parameters (bin_step, fee_tier) are auto-resolved from known pairs; override only if needed.\n\nWORKFLOW:\n1. Call mantle_getSwapPairs({ provider }) to see available pairs and their params\n2. Call mantle_getSwapQuote to get expected output amount\n3. Call mantle_buildApprove for token_in → router (if allowance insufficient)\n4. Call mantle_buildSwap with amount_out_min from the quote\n5. Sign and broadcast each unsigned_tx (value field is hex-encoded)\n\nExamples:\n- Swap 100 USDC for USDT0 on Merchant Moe: provider='merchant_moe', token_in='USDC', token_out='USDT0', amount_in='100', recipient='0x...' (bin_step auto-resolved to 1)\n- Swap 10 WMNT for USDC on Agni: provider='agni', token_in='WMNT', token_out='USDC', amount_in='10', recipient='0x...' (fee_tier auto-resolved to 10000)",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "DEX provider: 'agni', 'fluxion', or 'merchant_moe'."
        },
        token_in: {
          type: "string",
          description: "Input token symbol or address."
        },
        token_out: {
          type: "string",
          description: "Output token symbol or address."
        },
        amount_in: {
          type: "string",
          description: "Decimal amount of token_in to swap (e.g. '10')."
        },
        recipient: {
          type: "string",
          description: "Address to receive output tokens."
        },
        amount_out_min: {
          type: "string",
          description: "Minimum output in raw units (from mantle_getSwapQuote). Use '0' if unknown but NOT recommended."
        },
        slippage_bps: {
          type: "number",
          description: "Slippage tolerance in basis points (default: 50 = 0.5%)."
        },
        fee_tier: {
          type: "number",
          description:
            "V3 fee tier (500=0.05%, 3000=0.3%, 10000=1%). Auto-resolved from known pairs for agni/fluxion."
        },
        bin_step: {
          type: "number",
          description:
            "LB bin step (1=stablecoins, 5=LSTs, 20=volatile). Auto-resolved from known pairs for merchant_moe."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["provider", "token_in", "token_out", "amount_in", "recipient"]
    },
    handler: buildSwap
  },

  mantle_buildAddLiquidity: {
    name: "mantle_buildAddLiquidity",
    description:
      "Build an unsigned add-liquidity transaction. For V3 DEXes (agni/fluxion) mints an NFT position. For Merchant Moe LB adds to bin-based pools.\n\nExamples:\n- Full-range LP on Agni: provider='agni', token_a='WMNT', token_b='USDC', amount_a='10', amount_b='8', recipient='0x...'\n- LB LP on Merchant Moe: provider='merchant_moe', token_a='WMNT', token_b='USDe', amount_a='5', amount_b='4', recipient='0x...'",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "DEX provider: 'agni', 'fluxion', or 'merchant_moe'."
        },
        token_a: {
          type: "string",
          description: "First token symbol or address."
        },
        token_b: {
          type: "string",
          description: "Second token symbol or address."
        },
        amount_a: {
          type: "string",
          description: "Decimal amount of token_a."
        },
        amount_b: {
          type: "string",
          description: "Decimal amount of token_b."
        },
        recipient: {
          type: "string",
          description: "Address to receive LP position."
        },
        slippage_bps: {
          type: "number",
          description: "Slippage tolerance in basis points (default: 50)."
        },
        fee_tier: {
          type: "number",
          description: "V3 fee tier (default: 3000). For agni/fluxion."
        },
        tick_lower: {
          type: "number",
          description: "Lower tick bound. For agni/fluxion. Default: full range."
        },
        tick_upper: {
          type: "number",
          description: "Upper tick bound. For agni/fluxion. Default: full range."
        },
        bin_step: {
          type: "number",
          description: "LB bin step (default: 20). For merchant_moe."
        },
        active_id: {
          type: "number",
          description: "Active bin ID. For merchant_moe."
        },
        id_slippage: {
          type: "number",
          description: "Bin ID slippage tolerance. For merchant_moe."
        },
        delta_ids: {
          type: "array",
          description: "Relative bin IDs for distribution. For merchant_moe."
        },
        distribution_x: {
          type: "array",
          description: "Token X distribution per bin (1e18 = 100%). For merchant_moe."
        },
        distribution_y: {
          type: "array",
          description: "Token Y distribution per bin (1e18 = 100%). For merchant_moe."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: [
        "provider",
        "token_a",
        "token_b",
        "amount_a",
        "amount_b",
        "recipient"
      ]
    },
    handler: buildAddLiquidity
  },

  mantle_buildRemoveLiquidity: {
    name: "mantle_buildRemoveLiquidity",
    description:
      "Build an unsigned remove-liquidity transaction. For V3 DEXes uses decreaseLiquidity+collect via multicall. For Merchant Moe LB removes from specified bins.\n\nExamples:\n- Remove V3 position on Agni: provider='agni', token_id='12345', liquidity='1000000', recipient='0x...'\n- Remove LB bins on Merchant Moe: provider='merchant_moe', token_a='WMNT', token_b='USDC', ids=[8388608], amounts=['1000000'], recipient='0x...'",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "DEX provider: 'agni', 'fluxion', or 'merchant_moe'."
        },
        recipient: {
          type: "string",
          description: "Address to receive withdrawn tokens."
        },
        token_id: {
          type: "string",
          description: "V3 NFT position token ID. For agni/fluxion."
        },
        liquidity: {
          type: "string",
          description: "Amount of liquidity to remove. For agni/fluxion."
        },
        token_a: {
          type: "string",
          description: "First token symbol or address. For merchant_moe."
        },
        token_b: {
          type: "string",
          description: "Second token symbol or address. For merchant_moe."
        },
        bin_step: {
          type: "number",
          description: "LB bin step. For merchant_moe."
        },
        ids: {
          type: "array",
          description: "Bin IDs to remove from. For merchant_moe."
        },
        amounts: {
          type: "array",
          description: "Amounts per bin to remove. For merchant_moe."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["provider", "recipient"]
    },
    handler: buildRemoveLiquidity
  },

  mantle_buildAaveSupply: {
    name: "mantle_buildAaveSupply",
    description:
      "Build an unsigned Aave V3 supply (deposit) transaction. Remember to approve the asset for the Pool contract first.\n\nExamples:\n- Supply 100 USDC: asset='USDC', amount='100', on_behalf_of='0x...'\n- Supply 10 WMNT: asset='WMNT', amount='10', on_behalf_of='0x...'",
    inputSchema: {
      type: "object",
      properties: {
        asset: {
          type: "string",
          description: "Token symbol or address to supply."
        },
        amount: {
          type: "string",
          description: "Decimal amount to supply."
        },
        on_behalf_of: {
          type: "string",
          description: "Address that will receive the aTokens (typically the sender)."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["asset", "amount", "on_behalf_of"]
    },
    handler: buildAaveSupply
  },

  mantle_buildAaveBorrow: {
    name: "mantle_buildAaveBorrow",
    description:
      "Build an unsigned Aave V3 borrow transaction. Requires sufficient collateral deposited first.\n\nExamples:\n- Borrow 50 USDC at variable rate: asset='USDC', amount='50', on_behalf_of='0x...'\n- Borrow 10 WMNT at variable rate: asset='WMNT', amount='10', on_behalf_of='0x...'",
    inputSchema: {
      type: "object",
      properties: {
        asset: {
          type: "string",
          description: "Token symbol or address to borrow."
        },
        amount: {
          type: "string",
          description: "Decimal amount to borrow."
        },
        on_behalf_of: {
          type: "string",
          description: "Address of the borrower (must have collateral)."
        },
        interest_rate_mode: {
          type: "number",
          description: "2 = variable (default), 1 = stable."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["asset", "amount", "on_behalf_of"]
    },
    handler: buildAaveBorrow
  },

  mantle_buildAaveRepay: {
    name: "mantle_buildAaveRepay",
    description:
      "Build an unsigned Aave V3 repay transaction. Use amount='max' to repay the full debt. Remember to approve the asset for the Pool first.\n\nExamples:\n- Repay 50 USDC: asset='USDC', amount='50', on_behalf_of='0x...'\n- Repay full WMNT debt: asset='WMNT', amount='max', on_behalf_of='0x...'",
    inputSchema: {
      type: "object",
      properties: {
        asset: {
          type: "string",
          description: "Token symbol or address to repay."
        },
        amount: {
          type: "string",
          description: "Decimal amount to repay, or 'max' for full debt."
        },
        on_behalf_of: {
          type: "string",
          description: "Address of the borrower whose debt to repay."
        },
        interest_rate_mode: {
          type: "number",
          description: "2 = variable (default), 1 = stable."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["asset", "amount", "on_behalf_of"]
    },
    handler: buildAaveRepay
  },

  mantle_buildAaveWithdraw: {
    name: "mantle_buildAaveWithdraw",
    description:
      "Build an unsigned Aave V3 withdraw transaction. Use amount='max' to withdraw entire balance. May lower health factor.\n\nExamples:\n- Withdraw 50 USDC: asset='USDC', amount='50', to='0x...'\n- Withdraw all WMNT: asset='WMNT', amount='max', to='0x...'",
    inputSchema: {
      type: "object",
      properties: {
        asset: {
          type: "string",
          description: "Token symbol or address to withdraw."
        },
        amount: {
          type: "string",
          description: "Decimal amount to withdraw, or 'max' for full balance."
        },
        to: {
          type: "string",
          description: "Address to receive the withdrawn tokens."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["asset", "amount", "to"]
    },
    handler: buildAaveWithdraw
  },

  mantle_getSwapPairs: {
    name: "mantle_getSwapPairs",
    description:
      "List known trading pairs and their pool parameters for a DEX. Returns bin_step (Merchant Moe) or fee_tier (Agni/Fluxion) for each pair. Call this BEFORE mantle_buildSwap to get the correct pool parameters.\n\nExamples:\n- All Merchant Moe pairs: provider='merchant_moe'\n- All Agni pairs: provider='agni'\n- All pairs across all DEXes: (no provider)",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description:
            "Filter by DEX: 'agni', 'fluxion', or 'merchant_moe'. Omit for all DEXes."
        }
      },
      required: []
    },
    handler: getSwapPairs
  }
};
