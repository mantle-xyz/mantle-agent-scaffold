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

// Price fetch helpers for USD-based amount mode
const DEXSCREENER_API_BASE = "https://api.dexscreener.com";
const DEFILLAMA_PRICES_API_BASE = "https://coins.llama.fi/prices/current";

async function fetchJsonSafe(url: string, timeoutMs = 8000): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTokenPriceUsd(
  network: Network,
  tokenAddress: string
): Promise<number | null> {
  if (network !== "mainnet") return null;

  // Try DexScreener first
  const dsPayload = await fetchJsonSafe(
    `${DEXSCREENER_API_BASE}/tokens/v1/mantle/${tokenAddress}`
  );
  if (Array.isArray(dsPayload) && dsPayload.length > 0) {
    const best =
      dsPayload.find(
        (p: any) =>
          p.baseToken?.address?.toLowerCase() === tokenAddress.toLowerCase()
      ) ?? dsPayload[0];
    const price = typeof best?.priceUsd === "string" ? Number(best.priceUsd) : null;
    if (price != null && Number.isFinite(price) && price > 0) return price;
  }

  // Fallback to DefiLlama
  const llamaPayload = await fetchJsonSafe(
    `${DEFILLAMA_PRICES_API_BASE}/mantle:${tokenAddress.toLowerCase()}`
  );
  if (llamaPayload?.coins) {
    const key = `mantle:${tokenAddress.toLowerCase()}`;
    const coin = llamaPayload.coins[key];
    if (coin?.price && Number.isFinite(coin.price) && coin.price > 0) return coin.price;
  }

  return null;
}
import {
  findReserveBySymbol,
  findReserveByUnderlying,
  aaveReserveSymbols,
  isolationModeSymbols,
  isolationBorrowableSymbols,
  AAVE_V3_MANTLE_RESERVES,
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

/**
 * Common bridge tokens used as intermediaries for multi-hop routing.
 * Ordered by preference (most liquid first).
 */
const BRIDGE_TOKENS = ["WMNT", "USDC", "USDT0", "USDe", "WETH"] as const;

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
    /** Suggested gas limit. Wallets should use this or estimate on their own. */
    gas?: string;
  };
  warnings: string[];
  built_at_utc: string;
  /** Token metadata for proper decimal formatting. */
  token_info?: {
    token_in?: { symbol: string; decimals: number; address: string };
    token_out?: { symbol: string; decimals: number; address: string };
  };
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

  // Pre-check existing allowance (if owner is provided)
  const owner = typeof args.owner === "string" && isAddress(args.owner, { strict: false })
    ? getAddress(args.owner)
    : null;
  let existingAllowance: bigint | null = null;
  if (owner) {
    try {
      const client = d.getClient(network);
      existingAllowance = (await client.readContract({
        address: resolved.address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [owner as `0x${string}`, spender as `0x${string}`]
      })) as bigint;
    } catch {
      // Allowance check failed — proceed without it
    }
  }

  // If allowance is already sufficient, skip
  if (existingAllowance !== null && existingAllowance >= amountRaw) {
    const existingDecimal = formatUnits(existingAllowance, resolved.decimals);
    return {
      intent: "approve_skip",
      human_summary: `SKIP: ${resolved.symbol} already approved for ${whitelistLabel(spender, network) ?? spender}. Current allowance: ${existingDecimal} (sufficient).`,
      unsigned_tx: {
        to: resolved.address,
        data: "0x",
        value: "0x0",
        chainId: chainId(network)
      },
      warnings: [
        `Existing allowance ${existingDecimal} ${resolved.symbol} is sufficient. No approve transaction needed.`
      ],
      built_at_utc: d.now()
    };
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

// ---------------------------------------------------------------------------
// Multi-hop routing helpers
// ---------------------------------------------------------------------------

/**
 * Encode a V3 packed path for exactInput: token(20) + fee(3) + token(20) ...
 */
function encodeV3Path(tokens: string[], fees: number[]): `0x${string}` {
  let path = tokens[0].toLowerCase().slice(2);
  for (let i = 0; i < fees.length; i++) {
    path += fees[i].toString(16).padStart(6, "0");
    path += tokens[i + 1].toLowerCase().slice(2);
  }
  return `0x${path}` as `0x${string}`;
}

interface V3Route {
  tokens: ResolvedToken[];
  fees: number[];
}

interface MoeRoute {
  tokens: ResolvedToken[];
  binSteps: number[];
  routerVersions: number[];
}

/**
 * Find a 2-hop V3 route via common bridge tokens.
 * Returns the first viable route or null.
 */
function findV3Route(
  provider: "agni" | "fluxion",
  tokenIn: ResolvedToken,
  tokenOut: ResolvedToken,
  network: Network
): V3Route | null {
  for (const bridge of BRIDGE_TOKENS) {
    // Skip if bridge is same as in or out
    if (bridge.toLowerCase() === tokenIn.symbol.toLowerCase()) continue;
    if (bridge.toLowerCase() === tokenOut.symbol.toLowerCase()) continue;

    const legA =
      findPair(provider, tokenIn.symbol, bridge, network) ??
      findPairByAddress(provider, tokenIn.address, "", network); // fallback not useful here
    const legB =
      findPair(provider, bridge, tokenOut.symbol, network);

    if (legA && legB && legA.provider !== "merchant_moe" && legB.provider !== "merchant_moe") {
      // Need to resolve the bridge token address from the pair
      const bridgeAddress =
        legA.tokenA.toLowerCase() === tokenIn.symbol.toLowerCase()
          ? legA.tokenBAddress
          : legA.tokenAAddress;

      return {
        tokens: [
          tokenIn,
          { address: bridgeAddress, symbol: bridge, decimals: 0 }, // decimals not needed for path encoding
          tokenOut
        ],
        fees: [(legA as V3Pair).feeTier, (legB as V3Pair).feeTier]
      };
    }
  }
  return null;
}

/**
 * Find a 2-hop Merchant Moe route via common bridge tokens.
 */
function findMoeRoute(
  tokenIn: ResolvedToken,
  tokenOut: ResolvedToken,
  network: Network
): MoeRoute | null {
  for (const bridge of BRIDGE_TOKENS) {
    if (bridge.toLowerCase() === tokenIn.symbol.toLowerCase()) continue;
    if (bridge.toLowerCase() === tokenOut.symbol.toLowerCase()) continue;

    const legA = findPair("merchant_moe", tokenIn.symbol, bridge, network);
    const legB = findPair("merchant_moe", bridge, tokenOut.symbol, network);

    if (legA && legB && legA.provider === "merchant_moe" && legB.provider === "merchant_moe") {
      const bridgeAddress =
        legA.tokenA.toLowerCase() === tokenIn.symbol.toLowerCase()
          ? legA.tokenBAddress
          : legA.tokenAAddress;

      return {
        tokens: [
          tokenIn,
          { address: bridgeAddress, symbol: bridge, decimals: 0 },
          tokenOut
        ],
        binSteps: [(legA as MoePair).binStep, (legB as MoePair).binStep],
        routerVersions: [
          (legA as MoePair).routerVersion ?? 0,
          (legB as MoePair).routerVersion ?? 0
        ]
      };
    }
  }
  return null;
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

  // Accept caller-provided amount_out_min (from a prior quote call).
  // SAFETY: reject zero/missing amount_out_min unless explicitly opted out with
  // allow_zero_min=true. This prevents building swap calldata with no slippage
  // protection, which is vulnerable to sandwich attacks and MEV extraction.
  const allowZeroMin = args.allow_zero_min === true || args.allow_zero_min === "true";
  let amountOutMin: bigint;
  if (typeof args.amount_out_min === "string" && args.amount_out_min !== "0" && args.amount_out_min.trim().length > 0) {
    amountOutMin = BigInt(args.amount_out_min);
  } else if (allowZeroMin) {
    amountOutMin = 0n;
  } else {
    throw new MantleMcpError(
      "MISSING_SLIPPAGE_PROTECTION",
      "amount_out_min is required to protect against slippage and sandwich attacks.",
      "Call mantle_getSwapQuote first to get a quote, then pass amount_out_min (or minimum_out_raw from the quote). " +
      "Set allow_zero_min=true only if you understand the risks of unprotected swaps.",
      { token_in: tokenIn.symbol, token_out: tokenOut.symbol, amount_in: args.amount_in }
    );
  }

  const amountInDecimal = formatUnits(amountInRaw, tokenIn.decimals);
  const deadline = d.deadline();

  if (provider === "agni" || provider === "fluxion") {
    // Resolve fee_tier: caller > known pair > multi-hop > error
    let feeTier: number | undefined;
    if (typeof args.fee_tier === "number") {
      feeTier = args.fee_tier;
    } else if (knownPair && knownPair.provider !== "merchant_moe") {
      feeTier = (knownPair as V3Pair).feeTier;
    }

    if (feeTier !== undefined) {
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

    // No direct pair — try multi-hop via bridge token
    const route = findV3Route(provider, tokenIn, tokenOut, network);
    if (route) {
      return buildV3MultihopSwap({
        provider,
        route,
        tokenIn,
        tokenOut,
        amountInRaw,
        amountInDecimal,
        amountOutMin,
        recipient,
        deadline,
        network,
        now: d.now()
      });
    }

    const available = listPairs(provider).map(
      (p) => `${p.tokenA}/${p.tokenB}`
    );
    throw new MantleMcpError(
      "UNKNOWN_PAIR",
      `No known fee_tier or multi-hop route for ${tokenIn.symbol}/${tokenOut.symbol} on ${provider}. Provide fee_tier explicitly.`,
      `Known pairs on ${provider}: ${available.join(", ") || "none"}. Common fee tiers: 500 (0.05%), 3000 (0.3%), 10000 (1%).`,
      { provider, tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol }
    );
  }

  // merchant_moe — resolve bin_step: caller > known pair > multi-hop > error
  let binStep: number | undefined;
  let routerVersion: number = 0; // default V1 — works for all Moe pools
  if (typeof args.bin_step === "number") {
    binStep = args.bin_step;
  } else if (knownPair && knownPair.provider === "merchant_moe") {
    binStep = (knownPair as MoePair).binStep;
  }

  if (binStep !== undefined) {
    // Resolve router version: caller > known pair > default (0 = V1)
    if (typeof args.router_version === "number") {
      routerVersion = args.router_version;
    } else if (knownPair && knownPair.provider === "merchant_moe") {
      routerVersion = (knownPair as MoePair).routerVersion ?? 0;
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
      routerVersion,
      now: d.now()
    });
  }

  // No direct pair — try multi-hop via bridge token
  const moeRoute = findMoeRoute(tokenIn, tokenOut, network);
  if (moeRoute) {
    return buildMoeMultihopSwap({
      route: moeRoute,
      tokenIn,
      tokenOut,
      amountInRaw,
      amountInDecimal,
      amountOutMin,
      recipient,
      deadline,
      network,
      now: d.now()
    });
  }

  const available = listPairs("merchant_moe").map(
    (p) => `${p.tokenA}/${p.tokenB}`
  );
  throw new MantleMcpError(
    "UNKNOWN_PAIR",
    `No known bin_step or multi-hop route for ${tokenIn.symbol}/${tokenOut.symbol} on Merchant Moe. Provide bin_step explicitly.`,
    `Known pairs on Merchant Moe: ${available.join(", ")}. Common bin steps: 1 (stablecoins), 5 (LSTs), 20 (volatile).`,
    { provider, tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol }
  );
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
      `WARNING: amountOutMinimum is 0 — this swap has NO slippage protection and is vulnerable to sandwich attacks. Call mantle_getSwapQuote first and pass amount_out_min.`
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
      chainId: chainId(network),
      gas: "0x493E0" // 300000 — safe default for V3 swaps
    },
    token_info: {
      token_in: { symbol: tokenIn.symbol, decimals: tokenIn.decimals, address: tokenIn.address },
      token_out: { symbol: tokenOut.symbol, decimals: tokenOut.decimals, address: tokenOut.address }
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
  routerVersion: number;
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
    routerVersion,
    now
  } = params;

  const routerAddress = getContractAddress(
    "merchant_moe",
    "lb_router_v2_2",
    network
  );

  // LB Router path structure
  // routerVersion enum: 0=V1 (classic AMM), 1=V2, 2=V2.1, 3=V2.2
  const path = {
    pairBinSteps: [BigInt(binStep)],
    versions: [routerVersion],
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
  if (amountOutMin === 0n) {
    warnings.push(
      "WARNING: amountOutMin is 0 — this swap has NO slippage protection. Call mantle_getSwapQuote first and pass amount_out_min."
    );
  }

  return {
    intent: "swap",
    human_summary: `Swap ${amountInDecimal} ${tokenIn.symbol} → ${tokenOut.symbol} on Merchant Moe LB (bin step: ${binStep})`,
    unsigned_tx: {
      to: routerAddress,
      data,
      value: "0x0",
      chainId: chainId(network),
      gas: "0x7A120" // 500000 — safe default for LB swaps
    },
    token_info: {
      token_in: { symbol: tokenIn.symbol, decimals: tokenIn.decimals, address: tokenIn.address },
      token_out: { symbol: tokenOut.symbol, decimals: tokenOut.decimals, address: tokenOut.address }
    },
    warnings,
    built_at_utc: now
  };
}

// ---------------------------------------------------------------------------
// Multi-hop swap builders
// ---------------------------------------------------------------------------

function buildV3MultihopSwap(params: {
  provider: "agni" | "fluxion";
  route: V3Route;
  tokenIn: ResolvedToken;
  tokenOut: ResolvedToken;
  amountInRaw: bigint;
  amountInDecimal: string;
  amountOutMin: bigint;
  recipient: string;
  deadline: bigint;
  network: Network;
  now: string;
}): UnsignedTxResult {
  const {
    provider, route, tokenIn, tokenOut, amountInRaw, amountInDecimal,
    amountOutMin, recipient, deadline, network, now
  } = params;

  const routerAddress = getContractAddress(provider, "swap_router", network);
  const path = encodeV3Path(
    route.tokens.map((t) => t.address),
    route.fees
  );
  const hops = route.tokens.map((t) => t.symbol).join(" → ");

  const data = encodeFunctionData({
    abi: V3_SWAP_ROUTER_ABI,
    functionName: "exactInput",
    args: [
      {
        path,
        recipient: recipient as `0x${string}`,
        deadline,
        amountIn: amountInRaw,
        amountOutMinimum: amountOutMin
      }
    ]
  });

  const warnings: string[] = [];
  if (amountOutMin === 0n) {
    warnings.push(
      "WARNING: amountOutMinimum is 0. Multi-hop swaps have higher slippage risk — call mantle_getSwapQuote first and pass amount_out_min."
    );
  }
  warnings.push(`Multi-hop route: ${hops} (fees: ${route.fees.join(" → ")})`);

  const providerLabel = provider === "agni" ? "Agni" : "Fluxion";
  return {
    intent: "swap_multihop",
    human_summary: `Swap ${amountInDecimal} ${tokenIn.symbol} → ${tokenOut.symbol} via ${hops} on ${providerLabel}`,
    unsigned_tx: {
      to: routerAddress,
      data,
      value: "0x0",
      chainId: chainId(network),
      gas: "0x7A120" // 500000 — higher for multi-hop
    },
    token_info: {
      token_in: { symbol: tokenIn.symbol, decimals: tokenIn.decimals, address: tokenIn.address },
      token_out: { symbol: tokenOut.symbol, decimals: tokenOut.decimals, address: tokenOut.address }
    },
    warnings,
    built_at_utc: now
  };
}

function buildMoeMultihopSwap(params: {
  route: MoeRoute;
  tokenIn: ResolvedToken;
  tokenOut: ResolvedToken;
  amountInRaw: bigint;
  amountInDecimal: string;
  amountOutMin: bigint;
  recipient: string;
  deadline: bigint;
  network: Network;
  now: string;
}): UnsignedTxResult {
  const {
    route, tokenIn, tokenOut, amountInRaw, amountInDecimal,
    amountOutMin, recipient, deadline, network, now
  } = params;

  const routerAddress = getContractAddress("merchant_moe", "lb_router_v2_2", network);
  const hops = route.tokens.map((t) => t.symbol).join(" → ");

  const path = {
    pairBinSteps: route.binSteps.map(BigInt),
    versions: route.routerVersions,
    tokenPath: route.tokens.map((t) => t.address as `0x${string}`)
  };

  const data = encodeFunctionData({
    abi: LB_ROUTER_ABI,
    functionName: "swapExactTokensForTokens",
    args: [amountInRaw, amountOutMin, path, recipient as `0x${string}`, deadline]
  });

  const warnings: string[] = [];
  if (amountOutMin === 0n) {
    warnings.push(
      "amountOutMin is 0. Multi-hop swaps have higher slippage risk — call mantle_getSwapQuote first."
    );
  }
  warnings.push(
    `Multi-hop route: ${hops} (binSteps: ${route.binSteps.join(" → ")}, versions: ${route.routerVersions.join(" → ")})`
  );

  return {
    intent: "swap_multihop",
    human_summary: `Swap ${amountInDecimal} ${tokenIn.symbol} → ${tokenOut.symbol} via ${hops} on Merchant Moe`,
    unsigned_tx: {
      to: routerAddress,
      data,
      value: "0x0",
      chainId: chainId(network),
      gas: "0x9EB10" // 650000 — higher for multi-hop
    },
    token_info: {
      token_in: { symbol: tokenIn.symbol, decimals: tokenIn.decimals, address: tokenIn.address },
      token_out: { symbol: tokenOut.symbol, decimals: tokenOut.decimals, address: tokenOut.address }
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
  const recipient = requireAddress(args.recipient, "recipient");
  const deadline = d.deadline();
  const slippageBps =
    typeof args.slippage_bps === "number" ? args.slippage_bps : 50;

  let amountARaw: bigint;
  let amountBRaw: bigint;
  const warnings: string[] = [];

  // --- USD amount mode ---
  if (args.amount_usd != null && args.amount_usd !== "") {
    const usdAmount =
      typeof args.amount_usd === "number"
        ? args.amount_usd
        : typeof args.amount_usd === "string"
          ? Number(args.amount_usd)
          : NaN;

    if (!Number.isFinite(usdAmount) || usdAmount <= 0) {
      throw new MantleMcpError(
        "INVALID_INPUT",
        "amount_usd must be a positive number.",
        "Provide amount_usd as a positive decimal (e.g. 1000).",
        { amount_usd: args.amount_usd }
      );
    }

    // Fetch prices for both tokens
    const [priceA, priceB] = await Promise.all([
      fetchTokenPriceUsd(network, tokenA.address),
      fetchTokenPriceUsd(network, tokenB.address)
    ]);

    if (priceA == null || priceB == null) {
      throw new MantleMcpError(
        "PRICE_UNAVAILABLE",
        `Cannot fetch USD price for ${priceA == null ? tokenA.symbol : tokenB.symbol}. USD amount mode requires price data.`,
        "Use amount_a and amount_b instead, or retry later.",
        {
          token_a: tokenA.symbol,
          token_b: tokenB.symbol,
          price_a: priceA,
          price_b: priceB
        }
      );
    }

    // Compute pool-state-aware token ratio for V3 concentrated ranges.
    // For V3, the required ratio of token0:token1 depends on the current
    // price and the tick range. Full-range or Merchant Moe fall back to 50/50.
    let ratioA = 0.5; // fraction of USD allocated to token A
    let ratioMethod = "50/50 (default)";

    if (provider === "agni" || provider === "fluxion") {
      const tickLower = typeof args.tick_lower === "number" ? args.tick_lower : -887220;
      const tickUpper = typeof args.tick_upper === "number" ? args.tick_upper : 887220;
      const isFullRange = tickLower === -887220 && tickUpper === 887220;

      if (!isFullRange) {
        // Derive the ratio from V3 math:
        // For a V3 position, the value split depends on sqrtPrice relative to
        // the tick boundaries. We read the current pool price and compute
        // the USD value fraction each token occupies.
        try {
          const client = d.getClient(network);

          // Sort tokens the V3 way (token0 < token1)
          const [t0, t1, p0, p1] =
            tokenA.address.toLowerCase() < tokenB.address.toLowerCase()
              ? [tokenA, tokenB, priceA, priceB]
              : [tokenB, tokenA, priceB, priceA];

          const feeTier = typeof args.fee_tier === "number" ? args.fee_tier : 3000;
          const factoryAddress = getContractAddress(provider, "factory", network);
          const poolAddr = await client.readContract({
            address: factoryAddress as `0x${string}`,
            abi: [{ type: "function", name: "getPool", stateMutability: "view", inputs: [{ name: "", type: "address" }, { name: "", type: "address" }, { name: "", type: "uint24" }], outputs: [{ name: "", type: "address" }] }] as const,
            functionName: "getPool",
            args: [t0.address as `0x${string}`, t1.address as `0x${string}`, feeTier]
          }) as `0x${string}`;

          if (poolAddr && poolAddr !== "0x0000000000000000000000000000000000000000") {
            const slot0 = await client.readContract({
              address: poolAddr,
              abi: [{ type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [{ name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" }, { name: "", type: "uint16" }, { name: "", type: "uint16" }, { name: "", type: "uint16" }, { name: "", type: "uint8" }, { name: "", type: "bool" }] }] as const,
              functionName: "slot0"
            }) as readonly [bigint, number, ...unknown[]];

            const sqrtPriceX96 = slot0[0];
            const sqrtP = Number(sqrtPriceX96) / 2 ** 96;

            // sqrt prices at tick boundaries
            const sqrtPLower = Math.sqrt(1.0001 ** tickLower);
            const sqrtPUpper = Math.sqrt(1.0001 ** tickUpper);

            // V3 token amounts for 1 unit of liquidity:
            // amount0 = L * (1/sqrtP - 1/sqrtPUpper)  [when price is within range]
            // amount1 = L * (sqrtP - sqrtPLower)
            let amount0Frac: number;
            let amount1Frac: number;

            if (sqrtP <= sqrtPLower) {
              // Below range: all token0
              amount0Frac = 1;
              amount1Frac = 0;
            } else if (sqrtP >= sqrtPUpper) {
              // Above range: all token1
              amount0Frac = 0;
              amount1Frac = 1;
            } else {
              // Within range
              amount0Frac = (1 / sqrtP) - (1 / sqrtPUpper);
              amount1Frac = sqrtP - sqrtPLower;
            }

            // Convert to USD fractions using token prices
            const usd0 = amount0Frac * p0; // value of token0 portion
            const usd1 = amount1Frac * p1; // value of token1 portion
            const totalUsd = usd0 + usd1;

            if (totalUsd > 0) {
              // ratioA is the fraction going to tokenA (which may be token0 or token1)
              const ratioT0 = usd0 / totalUsd;
              ratioA = tokenA.address.toLowerCase() < tokenB.address.toLowerCase()
                ? ratioT0
                : 1 - ratioT0;
              ratioMethod = `pool-state-aware (tick range [${tickLower}, ${tickUpper}])`;
            }
          }
        } catch {
          // Fall back to 50/50 if pool read fails
          ratioMethod = "50/50 (pool read failed, fallback)";
        }
      }
    }

    const usdA = usdAmount * ratioA;
    const usdB = usdAmount * (1 - ratioA);
    const decimalA = usdA / priceA;
    const decimalB = usdB / priceB;

    amountARaw = parseUnits(decimalA.toFixed(tokenA.decimals), tokenA.decimals);
    amountBRaw = parseUnits(decimalB.toFixed(tokenB.decimals), tokenB.decimals);

    warnings.push(
      `USD mode: $${usdAmount} split ${(ratioA * 100).toFixed(1)}/${((1 - ratioA) * 100).toFixed(1)} [${ratioMethod}] → ` +
      `${formatUnits(amountARaw, tokenA.decimals)} ${tokenA.symbol} ($${usdA.toFixed(2)}) + ` +
      `${formatUnits(amountBRaw, tokenB.decimals)} ${tokenB.symbol} ($${usdB.toFixed(2)}). ` +
      `Prices: ${tokenA.symbol}=$${priceA.toFixed(4)}, ${tokenB.symbol}=$${priceB.toFixed(4)}.`
    );
  } else {
    // --- Standard token amount mode ---
    // Validate that at least one amount mode is provided
    if (
      (args.amount_a == null || args.amount_a === "") &&
      (args.amount_b == null || args.amount_b === "")
    ) {
      throw new MantleMcpError(
        "INVALID_INPUT",
        "Either (amount_a + amount_b) or amount_usd is required.",
        "Provide token amounts directly with amount_a and amount_b, or use amount_usd for automatic USD-based sizing.",
        { amount_a: args.amount_a ?? null, amount_b: args.amount_b ?? null, amount_usd: args.amount_usd ?? null }
      );
    }
    amountARaw = requirePositiveAmount(
      args.amount_a,
      "amount_a",
      tokenA.decimals
    );
    amountBRaw = requirePositiveAmount(
      args.amount_b,
      "amount_b",
      tokenB.decimals
    );
  }

  const amountADecimal = formatUnits(amountARaw, tokenA.decimals);
  const amountBDecimal = formatUnits(amountBRaw, tokenB.decimals);

  if (provider === "agni" || provider === "fluxion") {
    const result = buildV3AddLiquidity({
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
    result.warnings.push(...warnings);
    return result;
  }

  // merchant_moe LB
  const result = buildMoeAddLiquidity({
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
  result.warnings.push(...warnings);
  return result;
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
    const tokenIdInput =
      typeof args.token_id === "number"
        ? BigInt(args.token_id)
        : BigInt(requireString(args.token_id, "token_id"));

    let liquidityToRemove: bigint;
    const warnings: string[] = [];

    // --- Percentage mode for V3 ---
    if (args.percentage != null) {
      const pct =
        typeof args.percentage === "number"
          ? args.percentage
          : typeof args.percentage === "string"
            ? Number(args.percentage)
            : NaN;

      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        throw new MantleMcpError(
          "INVALID_INPUT",
          "percentage must be between 0 (exclusive) and 100 (inclusive).",
          "Provide percentage as a number 1-100 (e.g. 50 for half, 100 for full removal).",
          { percentage: args.percentage }
        );
      }

      // Read position to get current liquidity
      const positionManager = getContractAddress(
        provider,
        "position_manager",
        network
      );
      const client = d.getClient(network);
      const positionResult = await client.readContract({
        address: positionManager as `0x${string}`,
        abi: V3_POSITION_MANAGER_ABI,
        functionName: "positions",
        args: [tokenIdInput]
      });

      const positionData = positionResult as readonly [
        bigint, string, string, string, number, number, number,
        bigint, bigint, bigint, bigint, bigint
      ];
      const totalLiquidity = positionData[7];

      if (totalLiquidity === 0n) {
        throw new MantleMcpError(
          "INVALID_INPUT",
          "Position has zero liquidity — nothing to remove.",
          "Check position status with mantle_getV3Positions first.",
          { token_id: tokenIdInput.toString(), provider }
        );
      }

      liquidityToRemove = (totalLiquidity * BigInt(Math.round(pct * 100))) / 10000n;
      if (liquidityToRemove === 0n) liquidityToRemove = 1n; // prevent zero removal

      warnings.push(
        `Percentage mode: removing ${pct}% of position liquidity (${liquidityToRemove.toString()} of ${totalLiquidity.toString()}).`
      );
    } else {
      liquidityToRemove =
        typeof args.liquidity === "string"
          ? BigInt(args.liquidity)
          : typeof args.liquidity === "number"
            ? BigInt(args.liquidity)
            : 0n;
    }

    const result = buildV3RemoveLiquidity({
      provider,
      tokenId: tokenIdInput,
      liquidity: liquidityToRemove,
      amount0Min: 0n,
      amount1Min: 0n,
      recipient,
      deadline,
      network,
      now: d.now()
    });
    result.warnings.push(...warnings);
    return result;
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

  const warnings: string[] = [
    `Ensure ${reserve.symbol} is approved for the Aave Pool (${poolAddress}) before supplying.`
  ];

  // ── Isolation Mode warning ──────────────────────────────────────────
  if (reserve.isolationMode) {
    const ceilingUsd = reserve.debtCeilingUsd.toLocaleString("en-US");
    const borrowable = isolationBorrowableSymbols().join(", ");
    warnings.push(
      `ISOLATION MODE: ${reserve.symbol} is an Isolation Mode asset (debt ceiling $${ceilingUsd}). ` +
      `If this is your ONLY collateral you will enter Isolation Mode and can ONLY borrow: ${borrowable}. ` +
      `Other assets (e.g. sUSDe, FBTC, wrsETH) CANNOT be borrowed in Isolation Mode.`
    );
  }

  return {
    intent: "aave_supply",
    human_summary: `Supply ${amountDecimal} ${reserve.symbol} to Aave V3 (will receive a${reserve.symbol})`,
    unsigned_tx: {
      to: poolAddress,
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings,
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

  const warnings: string[] = [
    "Ensure you have sufficient collateral deposited before borrowing.",
    "Monitor your health factor to avoid liquidation."
  ];

  // ── Isolation Mode preflight ────────────────────────────────────────
  // When the requested asset is NOT borrowable in isolation, read the
  // borrower's aToken balances to detect isolation mode and fail-closed
  // rather than building a doomed transaction.
  if (!reserve.borrowableInIsolation) {
    try {
      const client = d.getClient(network);
      const isolationReserves = AAVE_V3_MANTLE_RESERVES.filter(r => r.isolationMode);
      const nonIsolationReserves = AAVE_V3_MANTLE_RESERVES.filter(r => !r.isolationMode);

      // Batch-read aToken balances for all reserves
      const [isoBalances, nonIsoBalances] = await Promise.all([
        Promise.all(
          isolationReserves.map(r =>
            (client.readContract({
              address: r.aToken as `0x${string}`,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [onBehalfOf as `0x${string}`]
            }) as Promise<bigint>).catch(() => 0n)
          )
        ),
        Promise.all(
          nonIsolationReserves.map(r =>
            (client.readContract({
              address: r.aToken as `0x${string}`,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [onBehalfOf as `0x${string}`]
            }) as Promise<bigint>).catch(() => 0n)
          )
        )
      ]);

      const hasIsolationCollateral = isoBalances.some(b => b > 0n);
      const hasNonIsolationCollateral = nonIsoBalances.some(b => b > 0n);

      if (hasIsolationCollateral && !hasNonIsolationCollateral) {
        // User is in isolation mode — cannot borrow this asset.
        const isoAssets = isolationReserves
          .filter((_, i) => isoBalances[i] > 0n)
          .map(r => r.symbol)
          .join(", ");
        const borrowable = isolationBorrowableSymbols().join(", ");
        throw new MantleMcpError(
          "ISOLATION_MODE_BORROW_BLOCKED",
          `Cannot borrow ${reserve.symbol}: borrower (${onBehalfOf}) is in Isolation Mode ` +
          `with only ${isoAssets} as collateral. ${reserve.symbol} is not borrowable in Isolation Mode.`,
          `In Isolation Mode you can only borrow: ${borrowable}. ` +
          `To borrow ${reserve.symbol}, supply additional non-isolation collateral (e.g. USDC).`,
          { borrower: onBehalfOf, collateral: isoAssets, asset: reserve.symbol }
        );
      }
    } catch (e) {
      // Re-throw our own errors; swallow RPC failures as a non-blocking warning
      if (e instanceof MantleMcpError) throw e;
      warnings.push(
        `ISOLATION MODE WARNING: ${reserve.symbol} is NOT borrowable in Isolation Mode. ` +
        `Could not verify borrower's collateral on-chain — if the borrower's only collateral ` +
        `is an Isolation Mode asset (${isolationModeSymbols().join(", ")}), this transaction WILL REVERT.`
      );
    }
  }

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
    warnings,
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
// Tool 10: mantle_buildCollectFees
// =========================================================================

const UINT128_MAX = BigInt("340282366920938463463374607431768211455");

export async function buildCollectFees(
  args: Record<string, unknown>,
  deps?: Partial<DefiWriteDeps>
): Promise<UnsignedTxResult> {
  const d = withDeps(deps);
  const { network } = normalizeNetwork(args);

  // Validate provider
  const providerInput = requireString(args.provider, "provider").toLowerCase();
  if (providerInput !== "agni" && providerInput !== "fluxion") {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `provider must be 'agni' or 'fluxion' for V3 fee collection.`,
      "Use provider='agni' or provider='fluxion'.",
      { provider: providerInput }
    );
  }
  const provider = providerInput as "agni" | "fluxion";

  // Validate token_id
  const tokenIdStr = requireString(args.token_id, "token_id");
  let tokenId: bigint;
  try {
    tokenId = BigInt(tokenIdStr);
  } catch {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `token_id must be a valid integer.`,
      "Provide the NFT token ID as a string (e.g. '12345').",
      { token_id: tokenIdStr }
    );
  }
  if (tokenId < 0n) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `token_id must be non-negative.`,
      "Provide a valid NFT token ID.",
      { token_id: tokenIdStr }
    );
  }

  // Validate recipient
  const recipient = requireAddress(args.recipient, "recipient");

  const positionManager = getContractAddress(
    provider,
    "position_manager",
    network
  );

  const data = encodeFunctionData({
    abi: V3_POSITION_MANAGER_ABI,
    functionName: "collect",
    args: [
      {
        tokenId,
        recipient: recipient as `0x${string}`,
        amount0Max: UINT128_MAX,
        amount1Max: UINT128_MAX
      }
    ]
  });

  const providerLabel = provider === "agni" ? "Agni" : "Fluxion";

  return {
    intent: "collect_fees",
    human_summary: `Collect accrued fees from ${providerLabel} V3 position #${tokenId} to ${recipient}`,
    unsigned_tx: {
      to: positionManager,
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings: [],
    built_at_utc: d.now()
  };
}

// =========================================================================
// Tool definitions (MCP schema)
// =========================================================================

export const defiWriteTools: Record<string, Tool> = {
  mantle_buildApprove: {
    name: "mantle_buildApprove",
    description:
      "Build an unsigned ERC-20 approve transaction. Validates spender is whitelisted. IMPORTANT: Pass 'owner' (the wallet address) to auto-check existing allowance — if already sufficient, returns intent='approve_skip' and you should NOT sign/broadcast.\n\nExamples:\n- Approve WMNT for Agni SwapRouter: token='WMNT', spender='0x319B69888b0d11cEC22caA5034e25FfFBDc88421', amount='100', owner='0xYourWallet'\n- Unlimited approve USDC for Aave Pool: token='USDC', spender='0x458F293454fE0d67EC0655f3672301301DD51422', amount='max', owner='0xYourWallet'",
    inputSchema: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description: "Token symbol (e.g. 'WMNT', 'USDC', 'USDT0') or address."
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
        owner: {
          type: "string",
          description:
            "Wallet address that owns the tokens. Used to check existing allowance and skip if sufficient."
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
          description: "REQUIRED: Minimum output in raw units (from mantle_getSwapQuote minimum_out_raw). Protects against slippage and sandwich attacks."
        },
        allow_zero_min: {
          type: "boolean",
          description: "Set to true to allow zero amount_out_min (DANGEROUS — no slippage protection). Only use for testing."
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
      "Build an unsigned add-liquidity transaction. For V3 DEXes (agni/fluxion) mints an NFT position. For Merchant Moe LB adds to bin-based pools.\n\nAmount modes:\n- Token amounts: provide amount_a and amount_b directly\n- USD amount: provide amount_usd to auto-split 50/50 between tokens (fetches live prices)\n\nExamples:\n- Token mode: provider='agni', token_a='WMNT', token_b='USDC', amount_a='10', amount_b='8', recipient='0x...'\n- USD mode: provider='agni', token_a='WMNT', token_b='USDC', amount_usd=1000, recipient='0x...'",
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
          description: "Decimal amount of token_a. Required unless amount_usd is provided."
        },
        amount_b: {
          type: "string",
          description: "Decimal amount of token_b. Required unless amount_usd is provided."
        },
        amount_usd: {
          type: "number",
          description:
            "USD amount to invest (auto-splits 50/50 between tokens using live prices). " +
            "Alternative to amount_a + amount_b. Example: 1000 for $1000."
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
        "recipient"
      ]
    },
    handler: buildAddLiquidity
  },

  mantle_buildRemoveLiquidity: {
    name: "mantle_buildRemoveLiquidity",
    description:
      "Build an unsigned remove-liquidity transaction. For V3 DEXes uses decreaseLiquidity+collect via multicall. For Merchant Moe LB removes from specified bins.\n\nV3 amount modes:\n- Exact liquidity: provide 'liquidity' as a raw amount\n- Percentage: provide 'percentage' (1-100) to remove a portion of the position (reads current liquidity on-chain)\n\nExamples:\n- Remove 50% of V3 position: provider='agni', token_id='12345', percentage=50, recipient='0x...'\n- Remove all V3 position: provider='agni', token_id='12345', percentage=100, recipient='0x...'\n- Remove exact liquidity: provider='agni', token_id='12345', liquidity='1000000', recipient='0x...'\n- Remove LB bins on Merchant Moe: provider='merchant_moe', token_a='WMNT', token_b='USDC', ids=[8388608], amounts=['1000000'], recipient='0x...'",
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
          description: "Exact amount of liquidity to remove. For agni/fluxion. Use 'percentage' for proportional removal."
        },
        percentage: {
          type: "number",
          description:
            "Percentage of position liquidity to remove (1-100). For agni/fluxion. " +
            "Reads current liquidity on-chain and calculates the amount. " +
            "Example: 50 removes half, 100 removes all."
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
      "Build an unsigned Aave V3 supply (deposit) transaction. Remember to approve the asset for the Pool contract first.\n\n" +
      "ISOLATION MODE: WETH and WMNT are Isolation Mode assets. Supplying them as your ONLY collateral " +
      "restricts borrows to: USDC, USDT0, USDe, GHO. Other assets CANNOT be borrowed in Isolation Mode.\n\n" +
      "Examples:\n- Supply 100 USDC: asset='USDC', amount='100', on_behalf_of='0x...'\n- Supply 10 WMNT: asset='WMNT', amount='10', on_behalf_of='0x...'",
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
      "Build an unsigned Aave V3 borrow transaction. Requires sufficient collateral deposited first.\n\n" +
      "ISOLATION MODE: If the borrower's only collateral is an Isolation Mode asset (WETH, WMNT), " +
      "they can ONLY borrow assets flagged as borrowableInIsolation: USDC, USDT0, USDe, GHO. " +
      "Attempting to borrow other assets (sUSDe, FBTC, syrupUSDT, wrsETH, WETH, WMNT) will REVERT.\n\n" +
      "Examples:\n- Borrow 50 USDC at variable rate: asset='USDC', amount='50', on_behalf_of='0x...'\n- Borrow 10 WMNT at variable rate: asset='WMNT', amount='10', on_behalf_of='0x...'",
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
  },

  mantle_buildCollectFees: {
    name: "mantle_buildCollectFees",
    description:
      "Build an unsigned transaction to collect accrued fees from a V3 LP position (Agni or Fluxion). Collects the maximum available fees for both tokens.\n\nWORKFLOW:\n1. Call mantle_getV3Positions to find positions with tokens_owed0/tokens_owed1 > 0\n2. Call mantle_buildCollectFees with the token_id\n3. Sign and broadcast the unsigned_tx\n\nExamples:\n- Collect Agni fees: provider='agni', token_id='12345', recipient='0x...'\n- Collect Fluxion fees: provider='fluxion', token_id='67890', recipient='0x...'",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "DEX provider: 'agni' or 'fluxion'."
        },
        token_id: {
          type: "string",
          description: "V3 NFT position token ID."
        },
        recipient: {
          type: "string",
          description: "Address to receive the collected fees."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["provider", "token_id", "recipient"]
    },
    handler: buildCollectFees
  }
};
