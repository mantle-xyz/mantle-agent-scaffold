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
  parseUnits,
  keccak256,
  toHex
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
import { LB_ROUTER_ABI, MOE_ROUTER_ABI, LB_QUOTER_ABI, LB_FACTORY_ABI, LB_PAIR_ABI } from "../lib/abis/merchant-moe-lb.js";
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
const BRIDGE_TOKENS = ["WMNT", "USDC", "USDT0", "USDT", "USDe", "WETH"] as const;

/**
 * xStocks RWA tokens — these ONLY have liquidity on Fluxion (USDC pairs).
 * Using any other provider will fail with no pool found.
 */
const XSTOCKS_SYMBOLS = new Set([
  "WTSLAX", "WAAPLX", "WCRCLX", "WSPYX", "WHOODX",
  "WMSTRX", "WNVDAX", "WGOOGLX", "WMETAX", "WQQQX"
]);

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
    // Specific guidance when user tries USDT (not USDT0) on Aave
    const isUsdt =
      symbolOrAddress.toUpperCase() === "USDT" ||
      symbolOrAddress.toLowerCase() === "0x201eba5cc46d216ce6dc03f6a759e8e766e956ae";
    const hint = isUsdt
      ? "Aave V3 on Mantle only supports USDT0 (0x779Ded0c9e1022225f8E0630b35a9b54bE713736), not USDT. " +
        "Swap USDT → USDT0 on Merchant Moe first (USDT/USDT0 pool, bin_step=1), then retry with USDT0."
      : `Supported assets: ${aaveReserveSymbols().join(", ")}.`;
    throw new MantleMcpError(
      "UNSUPPORTED_AAVE_ASSET",
      `'${symbolOrAddress}' is not a supported Aave V3 reserve on Mantle.`,
      hint,
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

/**
 * Returns a warning string if the network is sepolia (testnet).
 * Attach to warnings[] in write tools to alert users about testnet usage.
 */
function sepoliaWarning(network: Network): string | null {
  if (network === "sepolia") {
    return "TESTNET WARNING: You are building a transaction for Mantle Sepolia (testnet, chain_id=5003). " +
      "This has no real value. For mainnet operations, omit --network or use --network mainnet.";
  }
  return null;
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

  // Reject native MNT — it has no ERC-20 contract, cannot be used in
  // any DeFi tool that expects a contract address (swap, approve, LP, Aave).
  if (resolved.address === "native") {
    throw new MantleMcpError(
      "NATIVE_TOKEN_NOT_SUPPORTED",
      `MNT is the native gas token and has no ERC-20 contract address. ` +
        `It cannot be used directly in swaps, approvals, or DeFi operations.`,
      "Wrap MNT to WMNT first: mantle-cli swap wrap-mnt --amount <n> --json. " +
        "Then use WMNT for swaps, LP, and Aave. " +
        "To transfer native MNT, use: mantle-cli transfer send-native --to <addr> --amount <n> --json.",
      { token: input, resolved_address: "native" }
    );
  }

  if (resolved.decimals == null) {
    throw new MantleMcpError(
      "TOKEN_NOT_FOUND",
      `Cannot determine decimals for token '${input}'. Provide a known symbol or token address from the Mantle token list.`,
      "Use a well-known token symbol (WMNT, USDC, USDT, USDT0, USDe, mETH) or a verified address.",
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

// ---------------------------------------------------------------------------
// Idempotency key — deterministic, signer-scoped hash for deduplication.
//
// Key = keccak256(sender + request_id + to + data + value + chainId)
//
// • `sender` scopes the key to a specific wallet so two different signers
//   building the same calldata do NOT collide.
// • `request_id` lets the caller tag each user intent so the same wallet
//   can legitimately submit identical payloads for different user requests.
// • When neither is supplied the key still covers the calldata, but the
//   signer SHOULD inject its own address before deduplication.
// ---------------------------------------------------------------------------

function computeIdempotencyKey(
  unsignedTx: { to: string; data: string; value: string; chainId: number },
  sender: string | null,
  requestId: string | null
): string {
  const parts = [
    sender ?? "*",            // "*" = not scoped to a wallet
    requestId ?? "*",         // "*" = not scoped to a request
    unsignedTx.to,
    unsignedTx.data,
    unsignedTx.value,
    String(unsignedTx.chainId)
  ];
  const payload = parts.join(":");
  const encoded = toHex(new TextEncoder().encode(payload));
  return keccak256(encoded);
}

/**
 * Try to extract and normalize a valid address from an arg value.
 * Returns checksummed lowercase-safe address or null.
 */
function extractNormalizedAddress(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    if (isAddress(value.trim(), { strict: false })) {
      return getAddress(value.trim()).toLowerCase();
    }
  } catch {
    // Not a valid address — skip
  }
  return null;
}

/**
 * Wrap a build-tool handler to automatically append `idempotency_key`.
 *
 * The key is scoped to:
 *   - `sender` (signing wallet address) — extracted from args.sender,
 *     args.owner, args.on_behalf_of, or args.recipient; normalized to
 *     checksummed lowercase for format-invariant deduplication.
 *   - `request_id` — from args.request_id (caller-provided per-intent ID)
 *   - unsigned_tx fields (to, data, value, chainId)
 *
 * When sender cannot be resolved, `idempotency_key` is still emitted but
 * `idempotency_scope.sender` is set to `"unscoped"` so the executor knows
 * it must inject its own signer address before deduplicating.
 *
 * Handlers that return results without `unsigned_tx` (e.g. getSwapPairs)
 * pass through unchanged.
 */
function wrapBuildHandler(
  handler: (args: Record<string, unknown>, deps?: any) => Promise<any>
): (args: Record<string, unknown>, deps?: any) => Promise<any> {
  return async (args, deps) => {
    const result = await handler(args, deps);
    if (
      result &&
      typeof result === "object" &&
      result.unsigned_tx &&
      typeof result.unsigned_tx.to === "string" &&
      typeof result.unsigned_tx.data === "string"
    ) {
      // Extract sender scope from all possible arg fields, normalized.
      // Priority: explicit sender > owner > on_behalf_of > recipient
      const sender =
        extractNormalizedAddress(args.sender) ??
        extractNormalizedAddress(args.owner) ??
        extractNormalizedAddress(args.on_behalf_of) ??
        extractNormalizedAddress(args.recipient) ??
        null;

      const rawRequestId =
        typeof args.request_id === "string" ? args.request_id.trim() : "";
      const requestId = rawRequestId.length > 0 ? rawRequestId : null;

      const key = computeIdempotencyKey(result.unsigned_tx, sender, requestId);
      return {
        ...result,
        idempotency_key: key,
        idempotency_scope: {
          sender: sender ?? "unscoped",
          request_id: requestId ?? "none"
        }
      };
    }
    return result;
  };
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
  /**
   * Deterministic, signer-scoped hash for deduplication.
   *
   * Computed as keccak256(sender + request_id + to + data + value + chainId).
   * The sender address is normalized to checksummed lowercase before hashing,
   * so "0xABC..." and "0xabc..." produce the same key.
   *
   * The external signer / executor SHOULD use this key for deduplication:
   * if two build-tool calls from the SAME sender return the same
   * idempotency_key, the second transaction MUST NOT be signed or broadcast.
   *
   * Sender is extracted from args in priority order:
   *   sender > owner > on_behalf_of > recipient
   * This covers all builder call patterns (transfers, Aave, LP, etc.).
   *
   * When `idempotency_scope.sender` is `"unscoped"`, the executor MUST
   * inject its own signing wallet address before deduplicating — the raw
   * key alone is not wallet-safe in that case.
   *
   * Added automatically by the wrapBuildHandler wrapper.
   */
  idempotency_key?: string;
  /** Shows what scoped the idempotency_key (sender + request_id). */
  idempotency_scope?: {
    sender: string;
    request_id: string;
  };
  warnings: string[];
  built_at_utc: string;
  /** Token metadata for proper decimal formatting. */
  token_info?: {
    token_in?: { symbol: string; decimals: number; address: string };
    token_out?: { symbol: string; decimals: number; address: string };
  };
  /** Pool parameters used for the swap — enables cross-validation with quote. */
  pool_params?: {
    provider: string;
    fee_tier?: number;
    bin_step?: number;
    router_version?: number;
    pool_address?: string;
  };
  /** Present on Aave operations — the reserve's aToken and debt token. */
  aave_reserve?: {
    symbol: string;
    underlying: string;
    aToken: string;
    variableDebtToken: string;
    decimals: number;
  };
  /** Present on set-collateral: on-chain diagnostic reads before building the tx. */
  diagnostics?: {
    atoken_balance: string | null;
    collateral_already_enabled: boolean | null;
    reserve_ltv_bps: number | null;
    reserve_active: boolean | null;
    reserve_frozen: boolean | null;
    diagnosis: string;
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

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// =========================================================================
// Tool: mantle_buildTransferNative
// =========================================================================

export async function buildTransferNative(
  args: Record<string, unknown>,
  deps?: Partial<DefiWriteDeps>
): Promise<UnsignedTxResult> {
  const d = withDeps(deps);
  const { network } = normalizeNetwork(args);

  const to = requireAddress(args.to, "to");

  // Reject zero address to prevent silent burns
  if (to.toLowerCase() === ZERO_ADDRESS) {
    throw new MantleMcpError(
      "INVALID_RECIPIENT",
      "Cannot transfer to the zero address (0x0000...0000). This would irreversibly burn the tokens.",
      "Provide a valid recipient address.",
      { field: "to", value: to }
    );
  }

  const amountRaw = requirePositiveAmount(args.amount, "amount", 18);
  const amountDecimal = formatUnits(amountRaw, 18);

  const warnings: string[] = [];
  const sw = sepoliaWarning(network);
  if (sw) warnings.push(sw);

  return {
    intent: "transfer_native",
    human_summary: `Transfer ${amountDecimal} MNT → ${to}`,
    unsigned_tx: {
      to,
      data: "0x",
      value: "0x" + amountRaw.toString(16),
      chainId: chainId(network)
    },
    warnings,
    built_at_utc: d.now()
  };
}

// =========================================================================
// Tool: mantle_buildTransferToken
// =========================================================================

export async function buildTransferToken(
  args: Record<string, unknown>,
  deps?: Partial<DefiWriteDeps>
): Promise<UnsignedTxResult> {
  const d = withDeps(deps);
  const { network } = normalizeNetwork(args);

  const to = requireAddress(args.to, "to");

  // Reject zero address to prevent silent burns
  if (to.toLowerCase() === ZERO_ADDRESS) {
    throw new MantleMcpError(
      "INVALID_RECIPIENT",
      "Cannot transfer to the zero address (0x0000...0000). This would irreversibly burn the tokens.",
      "Provide a valid recipient address.",
      { field: "to", value: to }
    );
  }

  const tokenInput = requireString(args.token, "token");

  // Reject native MNT — must use buildTransferNative for native transfers
  if (tokenInput.toUpperCase() === "MNT") {
    throw new MantleMcpError(
      "USE_NATIVE_TRANSFER",
      "MNT is the native gas token and cannot be transferred via ERC-20 transfer.",
      "Use mantle_buildTransferNative (CLI: mantle-cli transfer send-native) to transfer native MNT.",
      { token: tokenInput }
    );
  }

  const resolved = await resolveToken(d, tokenInput, network);

  // Double-check: reject if resolved address is "native" sentinel
  if (resolved.address === "native" || !isAddress(resolved.address, { strict: false })) {
    throw new MantleMcpError(
      "USE_NATIVE_TRANSFER",
      `Token '${resolved.symbol}' resolves to the native asset and cannot be transferred via ERC-20 transfer.`,
      "Use mantle_buildTransferNative (CLI: mantle-cli transfer send-native) to transfer native MNT.",
      { token: tokenInput, resolved_address: resolved.address }
    );
  }

  const amountRaw = requirePositiveAmount(args.amount, "amount", resolved.decimals);
  const amountDecimal = formatUnits(amountRaw, resolved.decimals);

  const transferWarnings: string[] = [];
  const sw = sepoliaWarning(network);
  if (sw) transferWarnings.push(sw);

  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to as `0x${string}`, amountRaw]
  });

  return {
    intent: "transfer_token",
    human_summary: `Transfer ${amountDecimal} ${resolved.symbol} → ${to}`,
    unsigned_tx: {
      to: resolved.address,
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings: transferWarnings,
    built_at_utc: d.now(),
    token_info: {
      token_in: {
        symbol: resolved.symbol,
        decimals: resolved.decimals,
        address: resolved.address
      }
    }
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

import {
  discoverBestV3Pool as discoverBestV3PoolShared,
  type DiscoveredPool
} from "../lib/pool-discovery.js";

/**
 * Thin wrapper around the shared pool discovery that resolves
 * the factory address from the protocol registry.
 */
async function discoverBestV3Pool(
  provider: "agni" | "fluxion",
  tokenIn: ResolvedToken,
  tokenOut: ResolvedToken,
  network: Network,
  d: DefiWriteDeps
): Promise<DiscoveredPool | null> {
  let factoryAddress: `0x${string}`;
  try {
    factoryAddress = getContractAddress(provider, "factory", network) as `0x${string}`;
  } catch {
    return null;
  }
  return discoverBestV3PoolShared(
    d.getClient(network),
    factoryAddress,
    tokenIn.address as `0x${string}`,
    tokenOut.address as `0x${string}`
  );
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

// ---------------------------------------------------------------------------
// LB Quoter-based multi-hop route discovery (on-chain fallback)
// ---------------------------------------------------------------------------

const BRIDGE_TOKEN_ADDRESSES: Record<string, string> = {
  WMNT: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
  USDC: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
  USDT0: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
  USDT: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
  USDe: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
  WETH: "0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111"
};

interface MoeQuoterRoute {
  tokenPath: string[];
  binSteps: number[];
  versions: number[];
  amountOut: bigint;
}

/**
 * Use the Merchant Moe LB Quoter to discover routes on-chain.
 * Tries direct path + all 2-hop paths via bridge tokens.
 */
async function discoverMoeRouteViaQuoter(
  tokenIn: ResolvedToken,
  tokenOut: ResolvedToken,
  amountInRaw: bigint,
  network: Network,
  d: DefiWriteDeps
): Promise<MoeQuoterRoute | null> {
  let quoterAddr: string;
  try {
    quoterAddr = getContractAddress("merchant_moe", "lb_quoter_v2_2", network);
  } catch {
    return null;
  }

  const client = d.getClient(network);
  const inAddr = tokenIn.address as `0x${string}`;
  const outAddr = tokenOut.address as `0x${string}`;

  // Build candidate routes
  const routes: `0x${string}`[][] = [[inAddr, outAddr]];
  for (const [, bridgeAddr] of Object.entries(BRIDGE_TOKEN_ADDRESSES)) {
    const bridge = bridgeAddr as `0x${string}`;
    if (bridge.toLowerCase() === inAddr.toLowerCase()) continue;
    if (bridge.toLowerCase() === outAddr.toLowerCase()) continue;
    routes.push([inAddr, bridge, outAddr]);
  }

  const results = await Promise.allSettled(
    routes.map((route) =>
      client.readContract({
        address: quoterAddr as `0x${string}`,
        abi: LB_QUOTER_ABI,
        functionName: "findBestPathFromAmountIn",
        args: [route, amountInRaw]
      })
    )
  );

  let best: MoeQuoterRoute | null = null;

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const quote = result.value as {
      route: readonly string[];
      binSteps: readonly bigint[];
      versions: readonly bigint[];
      amounts: readonly bigint[];
    };

    const amounts = quote.amounts;
    if (!amounts || amounts.length === 0) continue;
    const amountOut = amounts[amounts.length - 1];
    if (amountOut <= 0n) continue;

    if (best === null || amountOut > best.amountOut) {
      best = {
        tokenPath: Array.from(quote.route).map(String),
        binSteps: Array.from(quote.binSteps).map(Number),
        versions: Array.from(quote.versions).map(Number),
        amountOut
      };
    }
  }

  return best;
}

/**
 * Build a Moe swap transaction using route info from the LB Quoter.
 */
function buildMoeMultihopSwapFromQuoter(params: {
  quoterRoute: MoeQuoterRoute;
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
    quoterRoute, tokenIn, tokenOut, amountInRaw, amountInDecimal,
    amountOutMin, recipient, deadline, network, now
  } = params;

  const routerAddress = getContractAddress("merchant_moe", "lb_router_v2_2", network);

  const path = {
    pairBinSteps: quoterRoute.binSteps.map(BigInt),
    versions: quoterRoute.versions,
    tokenPath: quoterRoute.tokenPath.map((a) => a as `0x${string}`)
  };

  const data = encodeFunctionData({
    abi: LB_ROUTER_ABI,
    functionName: "swapExactTokensForTokens",
    args: [amountInRaw, amountOutMin, path, recipient as `0x${string}`, deadline]
  });

  const isMultihop = quoterRoute.tokenPath.length > 2;
  const hops = quoterRoute.tokenPath.map((_, i) =>
    i < quoterRoute.tokenPath.length - 1 ? `step${i + 1}` : ""
  ).filter(Boolean).join("→");

  const warnings: string[] = [];
  if (amountOutMin === 0n) {
    warnings.push(
      "WARNING: amountOutMin is 0 — this swap has NO slippage protection."
    );
  }
  if (isMultihop) {
    warnings.push(
      `Multi-hop route discovered on-chain via LB Quoter: ${quoterRoute.tokenPath.length} tokens, ` +
      `binSteps: ${quoterRoute.binSteps.join(" → ")}`
    );
  }

  return {
    intent: isMultihop ? "swap_multihop" : "swap",
    human_summary: `Swap ${amountInDecimal} ${tokenIn.symbol} → ${tokenOut.symbol} on Merchant Moe LB` +
      (isMultihop ? ` (${quoterRoute.tokenPath.length - 1}-hop, on-chain route)` : ` (bin step: ${quoterRoute.binSteps[0]})`),
    unsigned_tx: {
      to: routerAddress,
      data,
      value: "0x0",
      chainId: chainId(network),
      gas: isMultihop ? "0x9EB10" : "0x7A120"
    },
    token_info: {
      token_in: { symbol: tokenIn.symbol, decimals: tokenIn.decimals, address: tokenIn.address },
      token_out: { symbol: tokenOut.symbol, decimals: tokenOut.decimals, address: tokenOut.address }
    },
    pool_params: {
      provider: "merchant_moe",
      bin_step: quoterRoute.binSteps[0]
    },
    warnings,
    built_at_utc: now
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

  // xStocks RWA tokens only have liquidity on Fluxion
  const xStockToken = [tokenIn, tokenOut].find(t =>
    XSTOCKS_SYMBOLS.has(t.symbol.toUpperCase())
  );
  if (xStockToken && provider !== "fluxion") {
    throw new MantleMcpError(
      "XSTOCKS_FLUXION_ONLY",
      `${xStockToken.symbol} is an xStocks RWA token that only has liquidity on Fluxion (USDC pairs, fee_tier=3000).`,
      `Use provider='fluxion' for xStocks swaps: mantle-cli swap build-swap --provider fluxion --in ${tokenIn.symbol} --out ${tokenOut.symbol} --amount <n> --recipient <addr> --json`,
      { token: xStockToken.symbol, requested_provider: provider, required_provider: "fluxion" }
    );
  }

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

  // ── Allowance pre-check (non-blocking warning) ────────────────────
  // When an explicit owner/sender address is provided, read their allowance
  // for the router and warn if insufficient. We do NOT use `recipient` here
  // because recipient is the output receiver, not the token owner/signer.
  const swapWarnings: string[] = [];
  const swSepolia = sepoliaWarning(network);
  if (swSepolia) swapWarnings.push(swSepolia);
  const swapOwner = typeof args.owner === "string" && isAddress(args.owner, { strict: false })
    ? getAddress(args.owner)
    : null;
  if (swapOwner) {
    try {
      const routerKey = provider === "merchant_moe" ? "lb_router_v2_2" : "swap_router";
      const routerAddress = getContractAddress(provider, routerKey, network);
      const client = d.getClient(network);
      const allowance = await client.readContract({
        address: tokenIn.address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [swapOwner as `0x${string}`, routerAddress as `0x${string}`]
      }) as bigint;
      if (allowance < amountInRaw) {
        const allowanceDecimal = formatUnits(allowance, tokenIn.decimals);
        swapWarnings.push(
          `INSUFFICIENT ALLOWANCE: ${tokenIn.symbol} allowance for ${provider} router is ${allowanceDecimal}, ` +
          `but swap requires ${amountInDecimal}. Build an approve tx first: ` +
          `mantle-cli swap approve --token ${tokenIn.symbol} --spender ${routerAddress} --amount ${amountInDecimal} --owner ${swapOwner} --json`
        );
      }
    } catch {
      // Non-critical — proceed without allowance check
    }
  }

  if (provider === "agni" || provider === "fluxion") {
    // Resolve fee_tier: caller-explicit > on-chain discovery > multi-hop > error
    let feeTier: number | undefined;
    if (typeof args.fee_tier === "number") {
      // User explicitly provided fee_tier — trust it
      feeTier = args.fee_tier;
    } else {
      // Auto-detect: query V3 factory for all common fee tiers and pick
      // the pool with the highest on-chain liquidity. This avoids the
      // stale-registry problem where a hardcoded fee_tier pool may have
      // migrated or lost liquidity.
      const bestPool = await discoverBestV3Pool(provider, tokenIn, tokenOut, network, d);
      if (bestPool) {
        feeTier = bestPool.feeTier;
      } else if (knownPair && knownPair.provider !== "merchant_moe") {
        // Fallback to static registry (pool may exist but have 0 liquidity)
        feeTier = (knownPair as V3Pair).feeTier;
      }
    }

    if (feeTier !== undefined) {
      // Cross-validate against quote parameters if provided
      const quoteFeeTier = typeof args.quote_fee_tier === "number" ? args.quote_fee_tier : null;
      const quoteProvider = typeof args.quote_provider === "string" ? args.quote_provider : null;
      const crossWarnings: string[] = [];
      if (quoteFeeTier != null && quoteFeeTier !== feeTier) {
        crossWarnings.push(
          `Quote used fee_tier ${quoteFeeTier} but build resolved fee_tier ${feeTier}. ` +
          `The minimum_out from your quote may not provide accurate slippage protection.`
        );
      }
      if (quoteProvider != null && quoteProvider !== provider) {
        crossWarnings.push(
          `Quote was from ${quoteProvider} but building on ${provider}. ` +
          `The minimum_out may not provide accurate slippage protection.`
        );
      }

      const result = buildV3Swap({
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
      result.warnings.push(...crossWarnings, ...swapWarnings);
      return result;
    }

    // No direct pair — try multi-hop via bridge token
    const route = findV3Route(provider, tokenIn, tokenOut, network);
    if (route) {
      const result = buildV3MultihopSwap({
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
      result.warnings.push(...swapWarnings);
      return result;
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

  // merchant_moe — resolve route:
  //   caller-explicit bin_step > LB Quoter on-chain > static registry fallback
  if (typeof args.bin_step === "number") {
    // User explicitly provided bin_step — resolve router_version from on-chain
    // factory to avoid the V1-default (0) being wrong for V2.2 pools.
    let routerVersion: number = 0;
    if (typeof args.router_version === "number") {
      routerVersion = args.router_version;
    } else {
      // Query LB Factory on-chain to get the real pair info and derive version
      try {
        const client = d.getClient(network);
        const factoryAddr = getContractAddress("merchant_moe", "lb_factory_v2_2", network) as `0x${string}`;
        const pairInfo = await client.readContract({
          address: factoryAddr,
          abi: LB_FACTORY_ABI,
          functionName: "getLBPairInformation",
          args: [
            tokenIn.address as `0x${string}`,
            tokenOut.address as `0x${string}`,
            BigInt(args.bin_step as number)
          ]
        }) as { binStep: number; LBPair: string; createdByOwner: boolean; ignoredForRouting: boolean };

        if (pairInfo.LBPair && pairInfo.LBPair !== "0x0000000000000000000000000000000000000000") {
          // V2.2 factory returned a valid pair → use router version 3 (V2.2)
          routerVersion = 3;
        }
      } catch {
        // Factory query failed — fall back to static registry or default
        if (knownPair && knownPair.provider === "merchant_moe") {
          routerVersion = (knownPair as MoePair).routerVersion ?? 0;
        }
      }
    }

    const moeResult = buildMoeSwap({
      tokenIn,
      tokenOut,
      amountInRaw,
      amountInDecimal,
      amountOutMin,
      slippageBps,
      recipient,
      deadline,
      network,
      binStep: args.bin_step as number,
      routerVersion,
      now: d.now()
    });
    moeResult.warnings.push(...swapWarnings);
    return moeResult;
  }

  // On-chain primary: use LB Quoter to discover the best route
  // (including multi-hop). This is the same quoter used by getSwapQuote,
  // ensuring quote and build select the same route.
  const moeQuoterRoute = await discoverMoeRouteViaQuoter(
    tokenIn, tokenOut, amountInRaw, network, d
  );
  if (moeQuoterRoute) {
    const result = buildMoeMultihopSwapFromQuoter({
      quoterRoute: moeQuoterRoute,
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

    // Cross-validate against quote parameters if provided
    const quoteBinStep = typeof args.quote_bin_step === "number" ? args.quote_bin_step : null;
    const quoteProvider = typeof args.quote_provider === "string" ? args.quote_provider : null;
    if (quoteBinStep != null && moeQuoterRoute.binSteps[0] !== quoteBinStep) {
      result.warnings.push(
        `Quote used bin_step ${quoteBinStep} but build resolved bin_step ${moeQuoterRoute.binSteps[0]}. ` +
        `The minimum_out from your quote may not provide accurate slippage protection.`
      );
    }
    if (quoteProvider != null && quoteProvider !== "merchant_moe") {
      result.warnings.push(
        `Quote was from ${quoteProvider} but building on merchant_moe. ` +
        `The minimum_out may not provide accurate slippage protection.`
      );
    }

    result.warnings.push(...swapWarnings);
    return result;
  }

  // Static registry fallback — only if LB Quoter fails/unavailable
  let binStep: number | undefined;
  let routerVersion: number = 0;
  if (knownPair && knownPair.provider === "merchant_moe") {
    binStep = (knownPair as MoePair).binStep;
    routerVersion = (knownPair as MoePair).routerVersion ?? 0;
  }

  if (binStep !== undefined) {
    const result = buildMoeSwap({
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
    result.warnings.push(
      "LB Quoter unavailable — using static registry for bin_step. " +
      "Route may differ from quote. Consider verifying with mantle_getSwapQuote.",
      ...swapWarnings
    );
    return result;
  }

  // Static multi-hop fallback
  const moeRoute = findMoeRoute(tokenIn, tokenOut, network);
  if (moeRoute) {
    const result = buildMoeMultihopSwap({
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
    result.warnings.push(
      "LB Quoter unavailable — using static registry for multi-hop route. " +
      "Route may differ from quote.",
      ...swapWarnings
    );
    return result;
  }

  const available = listPairs("merchant_moe").map(
    (p) => `${p.tokenA}/${p.tokenB}`
  );
  throw new MantleMcpError(
    "UNKNOWN_PAIR",
    `No known bin_step or multi-hop route for ${tokenIn.symbol}/${tokenOut.symbol} on Merchant Moe. Provide bin_step explicitly.`,
    `Known pairs on Merchant Moe: ${available.join(", ")}. Common bin steps: 1 (stablecoins), 2 (LSTs), 25 (volatile).`,
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
    pool_params: {
      provider,
      fee_tier: feeTier
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
    pool_params: {
      provider: "merchant_moe",
      bin_step: binStep,
      router_version: routerVersion
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
    pool_params: {
      provider,
      fee_tier: route.fees[0] // primary leg fee tier
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
    pool_params: {
      provider: "merchant_moe",
      bin_step: route.binSteps[0]
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
    const result = await buildV3AddLiquidity({
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
    binStep: typeof args.bin_step === "number" ? args.bin_step : 25,
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

async function buildV3AddLiquidity(params: {
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
}): Promise<UnsignedTxResult> {
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
  const swLp = sepoliaWarning(network);
  if (swLp) warnings.push(swLp);
  if (tickLower === -887220 && tickUpper === 887220) {
    warnings.push(
      "Using full-range tick bounds (MIN_TICK to MAX_TICK). Consider narrower range for concentrated liquidity."
    );
  }

  // Check if tick range includes current pool price
  try {
    const client = getPublicClient(network);
    const factoryAddress = getContractAddress(provider, "factory", network);
    const poolAddr = await client.readContract({
      address: factoryAddress as `0x${string}`,
      abi: [{ type: "function", name: "getPool", stateMutability: "view", inputs: [{ name: "", type: "address" }, { name: "", type: "address" }, { name: "", type: "uint24" }], outputs: [{ name: "", type: "address" }] }] as const,
      functionName: "getPool",
      args: [token0.address as `0x${string}`, token1.address as `0x${string}`, feeTier]
    }) as `0x${string}`;

    if (poolAddr && poolAddr !== "0x0000000000000000000000000000000000000000") {
      const slot0 = await client.readContract({
        address: poolAddr,
        abi: [{ type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [{ name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" }, { name: "", type: "uint16" }, { name: "", type: "uint16" }, { name: "", type: "uint16" }, { name: "", type: "uint8" }, { name: "", type: "bool" }] }] as const,
        functionName: "slot0"
      }) as readonly [bigint, number, ...unknown[]];

      const currentTick = slot0[1];
      if (currentTick < tickLower || currentTick >= tickUpper) {
        warnings.push(
          `OUT-OF-RANGE WARNING: Current pool tick is ${currentTick}, but your range is [${tickLower}, ${tickUpper}]. ` +
          `This position will NOT earn any trading fees until the price moves into your range. ` +
          `Consider using mantle-cli lp suggest-ticks to get recommended tick ranges.`
        );
      }
    }
  } catch {
    // Non-critical — proceed without tick check
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
    typeof args.bin_step === "number" ? args.bin_step : 25;

  const data = encodeFunctionData({
    abi: LB_ROUTER_ABI,
    functionName: "removeLiquidity",
    args: [
      tokenA.address as `0x${string}`,
      tokenB.address as `0x${string}`,
      binStep,
      0n, // amountXMin
      0n, // amountYMin
      // Accept ids/amounts as string OR number — callers (CLI, MCP) should
      // prefer strings for any value that may exceed Number.MAX_SAFE_INTEGER
      // so BigInt() preserves precision. LB-token amounts routinely do.
      (args.ids as (string | number)[]).map((v) => BigInt(v)),
      (args.amounts as (string | number)[]).map((v) => BigInt(v)),
      recipient as `0x${string}`,
      deadline
    ]
  });

  // Best-effort pre-flight: verify the router is approved to burn the user's
  // LB shares. Without this, the tx will revert with LBToken__SpenderNotApproved.
  // We surface it as a prominent warning (or skip-hint) rather than hard-failing,
  // so off-chain flows that set approval atomically can still build the tx.
  const warnings: string[] = [
    "amountXMin and amountYMin are 0. Consider setting minimum outputs to avoid MEV."
  ];
  try {
    const factoryAddr = getContractAddress(
      "merchant_moe",
      "lb_factory_v2_2",
      network
    ) as `0x${string}`;
    const client = d.getClient(network);
    const pairInfo = (await client.readContract({
      address: factoryAddr,
      abi: LB_FACTORY_ABI,
      functionName: "getLBPairInformation",
      args: [
        tokenA.address as `0x${string}`,
        tokenB.address as `0x${string}`,
        BigInt(binStep)
      ]
    })) as {
      binStep: number;
      LBPair: string;
      createdByOwner: boolean;
      ignoredForRouting: boolean;
    };
    if (
      pairInfo?.LBPair &&
      pairInfo.LBPair !== "0x0000000000000000000000000000000000000000"
    ) {
      const isApproved = (await client.readContract({
        address: pairInfo.LBPair as `0x${string}`,
        abi: LB_PAIR_ABI,
        functionName: "isApprovedForAll",
        args: [
          recipient as `0x${string}`,
          routerAddress as `0x${string}`
        ]
      })) as boolean;
      if (!isApproved) {
        warnings.unshift(
          `LB Router is NOT currently approved to burn your shares on pair ${pairInfo.LBPair}. ` +
          `The removeLiquidity tx WILL revert until you broadcast a \`mantle_buildSetLBApprovalForAll\` ` +
          `(CLI: \`lp approve-lb --pair ${pairInfo.LBPair} --operator ${routerAddress} --owner ${recipient}\`). ` +
          `NOTE: this pre-check assumes recipient == owner; if the LB shares are held by a different address, approve from that address instead.`
        );
      }
    }
  } catch {
    // Pre-check failure is non-critical (e.g. transient RPC error). Emit a
    // conservative hint so the caller knows the approval is a prerequisite.
    warnings.push(
      "Could not verify LB operator approval on-chain. If the router is not approved for the share owner, the tx will revert — use `mantle_buildSetLBApprovalForAll` / `lp approve-lb` first."
    );
  }

  return {
    intent: "remove_liquidity",
    human_summary: `Remove liquidity on Merchant Moe LB: ${tokenA.symbol}/${tokenB.symbol} (${(args.ids as unknown[]).length} bins)`,
    unsigned_tx: {
      to: routerAddress,
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings,
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
// Tool 6b: mantle_buildSetLBApprovalForAll
//
// Grants (or revokes) an operator — typically the LB Router — permission to
// burn the user's LB-token (ERC-1155-ish) shares on a given LB Pair. This
// is REQUIRED before `lp remove` can succeed on Merchant Moe: the router
// internally calls `LBPair.burn(user, ...)`, and LBToken's `checkApproval`
// modifier requires `isApprovedForAll(user, router) == true`.
// =========================================================================

export async function buildSetLBApprovalForAll(
  args: Record<string, unknown>,
  deps?: Partial<DefiWriteDeps>
): Promise<UnsignedTxResult> {
  const d = withDeps(deps);
  const { network } = normalizeNetwork(args);

  const operator = requireAddress(args.operator, "operator");
  const approvedFlag = args.approved === undefined ? true : Boolean(args.approved);

  // Only allow approving whitelisted protocol contracts (e.g. LB Router) —
  // same safety stance as ERC-20 approve.
  if (!isWhitelistedContract(operator, network)) {
    throw new MantleMcpError(
      "SPENDER_NOT_WHITELISTED",
      `Operator ${operator} is not a whitelisted contract.`,
      "Only whitelisted protocol contracts (e.g. the LB Router) can be approved as LB operators.",
      { operator, network }
    );
  }

  // Resolve the LB Pair address: either explicitly provided, or looked up
  // via the LB Factory using (token_a, token_b, bin_step).
  let pairAddress: string;
  if (typeof args.pair === "string" && isAddress(args.pair, { strict: false })) {
    pairAddress = getAddress(args.pair);
  } else {
    const tokenAInput = requireString(args.token_a, "token_a");
    const tokenBInput = requireString(args.token_b, "token_b");
    const tokenA = await resolveToken(d, tokenAInput, network);
    const tokenB = await resolveToken(d, tokenBInput, network);

    const binStepRaw = args.bin_step;
    const binStep =
      typeof binStepRaw === "number"
        ? binStepRaw
        : typeof binStepRaw === "string" && /^-?\d+$/.test(binStepRaw.trim())
          ? Number(binStepRaw.trim())
          : NaN;
    if (!Number.isFinite(binStep)) {
      throw new MantleMcpError(
        "INVALID_INPUT",
        "bin_step must be an integer.",
        "Provide bin_step as the LB pair bin step (e.g. 15, 25). Or pass 'pair' directly.",
        { bin_step: args.bin_step }
      );
    }

    const factoryAddr = getContractAddress(
      "merchant_moe",
      "lb_factory_v2_2",
      network
    ) as `0x${string}`;
    const client = d.getClient(network);
    const pairInfo = (await client.readContract({
      address: factoryAddr,
      abi: LB_FACTORY_ABI,
      functionName: "getLBPairInformation",
      args: [
        tokenA.address as `0x${string}`,
        tokenB.address as `0x${string}`,
        BigInt(binStep)
      ]
    })) as {
      binStep: number;
      LBPair: string;
      createdByOwner: boolean;
      ignoredForRouting: boolean;
    };

    if (
      !pairInfo?.LBPair ||
      pairInfo.LBPair === "0x0000000000000000000000000000000000000000"
    ) {
      throw new MantleMcpError(
        "PAIR_NOT_FOUND",
        `No LB pair found for ${tokenA.symbol}/${tokenB.symbol} with bin_step=${binStep}.`,
        "Verify the tokens and bin_step are correct, or pass 'pair' directly.",
        {
          token_a: tokenA.address,
          token_b: tokenB.address,
          bin_step: binStep
        }
      );
    }
    pairAddress = getAddress(pairInfo.LBPair);
  }

  // Pre-check existing approval state if owner provided. Short-circuit with
  // intent='approve_skip' if already at the desired state.
  const owner =
    typeof args.owner === "string" && isAddress(args.owner, { strict: false })
      ? getAddress(args.owner)
      : null;
  if (owner) {
    try {
      const client = d.getClient(network);
      const already = (await client.readContract({
        address: pairAddress as `0x${string}`,
        abi: LB_PAIR_ABI,
        functionName: "isApprovedForAll",
        args: [owner as `0x${string}`, operator as `0x${string}`]
      })) as boolean;
      if (already === approvedFlag) {
        return {
          intent: "approve_skip",
          human_summary: `SKIP: ${whitelistLabel(operator, network) ?? operator} is already ${approvedFlag ? "approved" : "revoked"} as LB operator on ${pairAddress}.`,
          unsigned_tx: {
            to: pairAddress,
            data: "0x",
            value: "0x0",
            chainId: chainId(network)
          },
          warnings: [
            `isApprovedForAll(${owner}, ${operator}) already returns ${already}. No transaction needed.`
          ],
          built_at_utc: d.now()
        };
      }
    } catch {
      // Pre-check failed (e.g. RPC hiccup) — proceed without skip.
    }
  }

  const data = encodeFunctionData({
    abi: LB_PAIR_ABI,
    functionName: "approveForAll",
    args: [operator as `0x${string}`, approvedFlag]
  });

  const opLabel = whitelistLabel(operator, network) ?? operator;
  return {
    intent: approvedFlag ? "approve_lb" : "approve_lb_revoke",
    human_summary: `${approvedFlag ? "Approve" : "Revoke"} ${opLabel} as LB operator on pair ${pairAddress} (ERC-1155 share approval required to remove liquidity via the router).`,
    unsigned_tx: {
      to: pairAddress,
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings: approvedFlag
      ? [
          "approveForAll grants the operator permission to burn ALL of your LB shares on this pair across every bin. Revoke with approved=false when you're done."
        ]
      : [],
    built_at_utc: d.now()
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

  // ── Isolation Mode warning (includes collateral check guidance) ─────
  if (reserve.isolationMode) {
    warnings.push(
      `COLLATERAL CHECK: ${reserve.symbol} is an Isolation Mode asset. After supply, verify ` +
      `getUserAccountData shows totalCollateralBase > 0. If collateral was not auto-enabled, ` +
      `call mantle_buildAaveSetCollateral with user=<address> to diagnose and fix.`
    );
  }

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
  const swBorrow = sepoliaWarning(network);
  if (swBorrow) warnings.push(swBorrow);

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

  // ── Health factor pre-check ─────────────────────────────────────────
  // Read current health factor to warn if this borrow brings it close
  // to liquidation. Non-blocking — failure to read just skips the check.
  try {
    const client = d.getClient(network);
    const accountData = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: AAVE_V3_POOL_ABI,
      functionName: "getUserAccountData",
      args: [onBehalfOf as `0x${string}`]
    }) as [bigint, bigint, bigint, bigint, bigint, bigint];

    const currentHf = accountData[5]; // healthFactor in WAD (1e18 = 1.0)
    const WAD = 10n ** 18n;

    if (currentHf > 0n && currentHf < WAD * 2n) {
      const hfDecimal = formatUnits(currentHf, 18);
      warnings.push(
        `HEALTH FACTOR WARNING: Current health factor is ${hfDecimal}. ` +
        `This borrow will further reduce it. Health factor below 1.0 triggers liquidation. ` +
        `Consider borrowing a smaller amount or adding more collateral first.`
      );
    }
  } catch {
    // Non-critical — proceed without health factor check
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
// Tool 11: mantle_buildAaveSetCollateral
// =========================================================================

/**
 * Decode reserve-level LTV and active/frozen flags from the Aave V3
 * configuration bitmap returned by Pool.getConfiguration(asset).
 *
 * Layout (see DataTypes.sol):
 *   bits  0-15  LTV (in basis points, 0 = cannot be used as collateral)
 *   bit   56    active
 *   bit   57    frozen
 */
function decodeReserveConfig(bitmap: bigint): {
  ltvBps: number;
  active: boolean;
  frozen: boolean;
} {
  const ltvBps = Number(bitmap & 0xFFFFn);
  const active = (bitmap >> 56n & 1n) === 1n;
  const frozen = (bitmap >> 57n & 1n) === 1n;
  return { ltvBps, active, frozen };
}

/**
 * Check whether a specific reserve's collateral flag is set for a user
 * from the bitmap returned by Pool.getUserConfiguration(user).
 *
 * Layout: for each reserve with id `i`:
 *   bit  i * 2      isBorrowing
 *   bit  i * 2 + 1  isUsingAsCollateral
 */
function isCollateralEnabled(userConfigBitmap: bigint, reserveId: number): boolean {
  const bit = BigInt(reserveId * 2 + 1);
  return (userConfigBitmap >> bit & 1n) === 1n;
}

export async function buildAaveSetCollateral(
  args: Record<string, unknown>,
  deps?: Partial<DefiWriteDeps>
): Promise<UnsignedTxResult> {
  const d = withDeps(deps);
  const { network } = normalizeNetwork(args);

  const assetInput = requireString(args.asset, "asset");
  const reserve = requireAaveReserve(assetInput);
  const asset = await resolveToken(d, reserve.underlying, network);

  // Default to enabling collateral (true) — the common case is fixing
  // a supply that didn't auto-enable collateral.
  const useAsCollateral =
    args.use_as_collateral === false || args.use_as_collateral === "false"
      ? false
      : true;

  const poolAddress = getContractAddress("aave_v3", "pool", network);
  const action = useAsCollateral ? "Enable" : "Disable";
  const warnings: string[] = [];

  // ── msg.sender semantics ──────────────────────────────────────────
  // setUserUseReserveAsCollateral operates on msg.sender, NOT an
  // arbitrary address.  The `user` param is only used for preflight
  // diagnostics below — it is NOT encoded into the transaction.
  const userRaw = args.user ?? args.on_behalf_of;
  const user = typeof userRaw === "string" && isAddress(userRaw, { strict: false })
    ? getAddress(userRaw) as `0x${string}`
    : null;

  warnings.push(
    "MSG.SENDER: This transaction operates on the signing wallet (msg.sender), " +
    "not an arbitrary address. The signer must be the user who supplied the asset."
  );

  // ── Preflight diagnostics (best-effort, non-blocking) ────────────
  // Read on-chain state to diagnose the actual condition and warn early
  // if the tx would revert or be a no-op.
  let diagnostics: NonNullable<UnsignedTxResult["diagnostics"]> = {
    atoken_balance: null,
    collateral_already_enabled: null,
    reserve_ltv_bps: null,
    reserve_active: null,
    reserve_frozen: null,
    diagnosis: "preflight_skipped"
  };

  if (user) {
    try {
      const client = d.getClient(network);

      // Batch three reads: aToken balance, reserve config, user config
      const [aTokenResult, reserveConfigResult, userConfigResult] = await client.multicall({
        contracts: [
          {
            address: reserve.aToken as `0x${string}`,
            abi: ERC20_ABI,
            functionName: "balanceOf" as const,
            args: [user]
          },
          {
            address: poolAddress as `0x${string}`,
            abi: AAVE_V3_POOL_ABI,
            functionName: "getConfiguration" as const,
            args: [asset.address as `0x${string}`]
          },
          {
            address: poolAddress as `0x${string}`,
            abi: AAVE_V3_POOL_ABI,
            functionName: "getUserConfiguration" as const,
            args: [user]
          }
        ]
      });

      // Parse aToken balance
      const aTokenBalance = aTokenResult.status === "success"
        ? (aTokenResult.result as bigint) : null;

      // Parse reserve configuration
      let reserveConfig: ReturnType<typeof decodeReserveConfig> | null = null;
      if (reserveConfigResult.status === "success") {
        const raw = reserveConfigResult.result as bigint;
        reserveConfig = decodeReserveConfig(raw);
      }

      // Parse user configuration
      let collateralEnabled: boolean | null = null;
      if (userConfigResult.status === "success") {
        const raw = userConfigResult.result as bigint;
        collateralEnabled = isCollateralEnabled(raw, reserve.id);
      }

      diagnostics = {
        atoken_balance: aTokenBalance !== null
          ? formatUnits(aTokenBalance, reserve.decimals)
          : null,
        collateral_already_enabled: collateralEnabled,
        reserve_ltv_bps: reserveConfig?.ltvBps ?? null,
        reserve_active: reserveConfig?.active ?? null,
        reserve_frozen: reserveConfig?.frozen ?? null,
        diagnosis: "ok"
      };

      // ── Fail-closed checks ──────────────────────────────────────
      if (aTokenBalance !== null && aTokenBalance === 0n) {
        throw new MantleMcpError(
          "NO_SUPPLY_BALANCE",
          `Cannot ${action.toLowerCase()} collateral for ${reserve.symbol}: ` +
          `user ${user} has no aToken balance (0 supplied).`,
          `Supply ${reserve.symbol} to Aave first before enabling it as collateral.`,
          { user, asset: reserve.symbol }
        );
      }

      if (reserveConfig && !reserveConfig.active) {
        throw new MantleMcpError(
          "RESERVE_NOT_ACTIVE",
          `Cannot ${action.toLowerCase()} collateral for ${reserve.symbol}: reserve is not active.`,
          "This reserve may have been deactivated by Aave governance.",
          { asset: reserve.symbol }
        );
      }

      if (reserveConfig && reserveConfig.frozen) {
        warnings.push(
          `WARNING: ${reserve.symbol} reserve is FROZEN. The collateral toggle may still work ` +
          `but no new borrows or supplies are accepted.`
        );
      }

      if (useAsCollateral && reserveConfig && reserveConfig.ltvBps === 0) {
        throw new MantleMcpError(
          "LTV_IS_ZERO",
          `Cannot enable ${reserve.symbol} as collateral: on-chain LTV is 0 basis points.`,
          `${reserve.symbol} is configured with LTV=0 by Aave governance on Mantle, ` +
          `meaning it cannot be used as collateral regardless of the collateral flag. ` +
          `This is likely the root cause of borrow failures — not a missing collateral toggle.`,
          { asset: reserve.symbol, ltvBps: 0 }
        );
      }

      if (collateralEnabled !== null && collateralEnabled === useAsCollateral) {
        const state = useAsCollateral ? "enabled" : "disabled";
        warnings.push(
          `NO-OP: Collateral for ${reserve.symbol} is already ${state} for user ${user}. ` +
          `This transaction would have no effect. If borrow still fails, the root cause ` +
          `is likely oracle pricing, LTV configuration, or reserve status — not the collateral flag.`
        );
        diagnostics.diagnosis = "already_in_desired_state";
      }
    } catch (e) {
      // Re-throw our own errors; swallow RPC failures as non-blocking
      if (e instanceof MantleMcpError) throw e;
      warnings.push(
        `Preflight diagnostics failed (RPC error). The transaction was still built ` +
        `but could not verify on-chain state. Proceed with caution.`
      );
      diagnostics.diagnosis = "preflight_rpc_error";
    }
  } else {
    warnings.push(
      "No user address provided — preflight diagnostics were skipped. " +
      "Pass user=<address> to enable on-chain checks before building the transaction."
    );
  }

  if (reserve.isolationMode && useAsCollateral) {
    const borrowable = isolationBorrowableSymbols().join(", ");
    warnings.push(
      `ISOLATION MODE: ${reserve.symbol} is an Isolation Mode asset. ` +
      `If this is your ONLY collateral you will be in Isolation Mode and can ONLY borrow: ${borrowable}.`
    );
  }

  if (!useAsCollateral) {
    warnings.push(
      "Disabling collateral will reduce your borrowing capacity and may lower your health factor. " +
      "If your health factor drops below 1, you may be liquidated."
    );
  }

  const data = encodeFunctionData({
    abi: AAVE_V3_POOL_ABI,
    functionName: "setUserUseReserveAsCollateral",
    args: [
      asset.address as `0x${string}`,
      useAsCollateral
    ]
  });

  return {
    intent: "aave_set_collateral",
    human_summary: `${action} ${reserve.symbol} as collateral on Aave V3`,
    unsigned_tx: {
      to: poolAddress,
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings,
    diagnostics,
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
// Tool 12: mantle_getSwapPairs (read-only — returns known pair configs)
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
  mantle_buildTransferNative: {
    name: "mantle_buildTransferNative",
    description:
      "Build an unsigned transaction to transfer native MNT to a recipient address. " +
      "Handles decimal-to-wei conversion and hex encoding deterministically — " +
      "NEVER manually compute wei values or hex-encode transfer amounts.\n\n" +
      "DEDUPLICATION: Response includes idempotency_key. Pass sender (signing wallet address) " +
      "to scope the key per-wallet. Pass request_id (unique per user intent) to prevent " +
      "false deduplication across separate user requests.\n\n" +
      "Examples:\n" +
      "- Send 15 MNT: amount='15', to='0x...', sender='0x<signing_wallet>'\n" +
      "- Send 0.5 MNT: amount='0.5', to='0x...'",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient address."
        },
        amount: {
          type: "string",
          description: "Decimal amount of MNT to transfer (e.g. '15', '0.5')."
        },
        sender: {
          type: "string",
          description: "Signing wallet address. Scopes idempotency_key to this wallet so different wallets can independently execute identical transfers."
        },
        request_id: {
          type: "string",
          description: "Unique ID for this user intent (e.g. UUID). Prevents false deduplication when the same wallet legitimately builds identical transactions for different requests."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["to", "amount"]
    },
    handler: wrapBuildHandler(buildTransferNative)
  },

  mantle_buildTransferToken: {
    name: "mantle_buildTransferToken",
    description:
      "Build an unsigned ERC-20 transfer transaction to send tokens to a recipient. " +
      "Resolves token symbol to address and decimals from the registry, then encodes " +
      "the transfer calldata deterministically — NEVER manually compute raw amounts " +
      "or hex-encode transfer values.\n\n" +
      "DEDUPLICATION: Response includes idempotency_key. Pass sender (signing wallet address) " +
      "to scope the key per-wallet.\n\n" +
      "Examples:\n" +
      "- Send 100 USDC: token='USDC', amount='100', to='0x...', sender='0x<signing_wallet>'\n" +
      "- Send 50 WMNT: token='WMNT', amount='50', to='0x...'",
    inputSchema: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description: "Token symbol (e.g. 'USDC', 'WMNT', 'USDT0') or address."
        },
        to: {
          type: "string",
          description: "Recipient address."
        },
        amount: {
          type: "string",
          description: "Decimal amount of tokens to transfer (e.g. '100', '0.5')."
        },
        sender: {
          type: "string",
          description: "Signing wallet address. Scopes idempotency_key to this wallet."
        },
        request_id: {
          type: "string",
          description: "Unique ID for this user intent. Prevents false deduplication across separate requests."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["token", "to", "amount"]
    },
    handler: wrapBuildHandler(buildTransferToken)
  },

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
    handler: wrapBuildHandler(buildApprove)
  },

  mantle_buildWrapMnt: {
    name: "mantle_buildWrapMnt",
    description:
      "Build an unsigned transaction to wrap MNT into WMNT. Returns calldata with value field set to the wrap amount.\n\nExamples:\n- Wrap 10 MNT: amount='10', sender='0x<signing_wallet>'\n- Wrap 0.5 MNT: amount='0.5'",
    inputSchema: {
      type: "object",
      properties: {
        amount: {
          type: "string",
          description: "Decimal amount of MNT to wrap (e.g. '10')."
        },
        sender: {
          type: "string",
          description: "Signing wallet address. Scopes idempotency_key to this wallet."
        },
        request_id: {
          type: "string",
          description: "Unique ID for this user intent."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["amount"]
    },
    handler: wrapBuildHandler(buildWrapMnt)
  },

  mantle_buildUnwrapMnt: {
    name: "mantle_buildUnwrapMnt",
    description:
      "Build an unsigned transaction to unwrap WMNT back to MNT.\n\nExamples:\n- Unwrap 10 WMNT: amount='10', sender='0x<signing_wallet>'\n- Unwrap 0.5 WMNT: amount='0.5'",
    inputSchema: {
      type: "object",
      properties: {
        amount: {
          type: "string",
          description: "Decimal amount of WMNT to unwrap (e.g. '10')."
        },
        sender: {
          type: "string",
          description: "Signing wallet address. Scopes idempotency_key to this wallet."
        },
        request_id: {
          type: "string",
          description: "Unique ID for this user intent."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["amount"]
    },
    handler: wrapBuildHandler(buildUnwrapMnt)
  },

  mantle_buildSwap: {
    name: "mantle_buildSwap",
    description:
      "Build an unsigned swap transaction on a whitelisted DEX. Pool parameters (bin_step, fee_tier) are auto-discovered on-chain for the best liquidity pool.\n\nWORKFLOW:\n1. Call mantle_getSwapQuote to get expected output, provider, and resolved_pool_params\n2. Call mantle_buildApprove for token_in → router (if allowance insufficient)\n3. Call mantle_buildSwap with: provider from quote, amount_out_min from quote's minimum_out_raw, and quote_fee_tier/quote_provider from resolved_pool_params for cross-validation\n4. Sign and broadcast each unsigned_tx\n\nThe response includes pool_params showing the actual fee_tier/bin_step used — compare with your quote's resolved_pool_params to verify consistency.\n\nExamples:\n- Swap 100 USDC for USDT0 on Merchant Moe: provider='merchant_moe', token_in='USDC', token_out='USDT0', amount_in='100', recipient='0x...'\n- Swap 10 WMNT for USDC on Agni: provider='agni', token_in='WMNT', token_out='USDC', amount_in='10', recipient='0x...'",
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
            "LB bin step (1=stablecoins, 2=LSTs, 25=volatile). Auto-resolved from known pairs for merchant_moe."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        },
        quote_provider: {
          type: "string",
          description: "Provider from a prior getSwapQuote call. Used to cross-validate consistency — emits a warning if build resolves a different provider."
        },
        quote_fee_tier: {
          type: "number",
          description: "Fee tier from a prior getSwapQuote resolved_pool_params. Used to cross-validate — emits a warning if build resolves a different fee tier."
        },
        quote_bin_step: {
          type: "number",
          description: "Bin step from a prior getSwapQuote resolved_pool_params. Used to cross-validate — emits a warning if build resolves a different bin step."
        },
        owner: {
          type: "string",
          description: "Wallet address that owns the input tokens (the signer). Used for optional allowance pre-check — emits a warning if allowance is insufficient."
        }
      },
      required: ["provider", "token_in", "token_out", "amount_in", "recipient"]
    },
    handler: wrapBuildHandler(buildSwap)
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
          description: "LB bin step (default: 25). For merchant_moe."
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
    handler: wrapBuildHandler(buildAddLiquidity)
  },

  mantle_buildRemoveLiquidity: {
    name: "mantle_buildRemoveLiquidity",
    description:
      "Build an unsigned remove-liquidity transaction. For V3 DEXes uses decreaseLiquidity+collect via multicall. For Merchant Moe LB removes from specified bins.\n\nV3 amount modes:\n- Exact liquidity: provide 'liquidity' as a raw amount\n- Percentage: provide 'percentage' (1-100) to remove a portion of the position (reads current liquidity on-chain)\n\nIMPORTANT (Merchant Moe): the LB Router must first be approved as an operator on the LB Pair (ERC-1155 `approveForAll`) — without this the tx will revert. Use `mantle_buildSetLBApprovalForAll` (CLI: `lp approve-lb`) before the first remove on a given pair.\n\nExamples:\n- Remove 50% of V3 position: provider='agni', token_id='12345', percentage=50, recipient='0x...'\n- Remove all V3 position: provider='agni', token_id='12345', percentage=100, recipient='0x...'\n- Remove exact liquidity: provider='agni', token_id='12345', liquidity='1000000', recipient='0x...'\n- Remove LB bins on Merchant Moe: provider='merchant_moe', token_a='WMNT', token_b='USDC', ids=[8388608], amounts=['1000000'], recipient='0x...'",
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
    handler: wrapBuildHandler(buildRemoveLiquidity)
  },

  mantle_buildSetLBApprovalForAll: {
    name: "mantle_buildSetLBApprovalForAll",
    description:
      "Build an unsigned `approveForAll` transaction on a Merchant Moe LB Pair (ERC-1155-style share approval). This is REQUIRED before `mantle_buildRemoveLiquidity` can succeed for merchant_moe: the router burns the user's LB shares via `LBPair.burn(user, ...)`, which requires `isApprovedForAll(user, router) == true`. Pair can be specified directly via 'pair', or resolved from 'token_a' + 'token_b' + 'bin_step' via the LB Factory. Pass 'owner' to auto-skip when the operator is already in the desired state (intent='approve_skip').\n\nExamples:\n- Approve LB Router to burn WMNT/USDT shares: token_a='WMNT', token_b='USDT', bin_step=15, operator='0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a', owner='0xYourWallet'\n- Revoke: approved=false",
    inputSchema: {
      type: "object",
      properties: {
        pair: {
          type: "string",
          description: "LB Pair contract address. If omitted, resolved from token_a/token_b/bin_step."
        },
        token_a: {
          type: "string",
          description: "First token symbol or address (alternative to 'pair')."
        },
        token_b: {
          type: "string",
          description: "Second token symbol or address (alternative to 'pair')."
        },
        bin_step: {
          type: "number",
          description: "LB pair bin step (alternative to 'pair'). E.g. 15, 25."
        },
        operator: {
          type: "string",
          description: "Address to approve/revoke (must be a whitelisted contract, typically the LB Router)."
        },
        approved: {
          type: "boolean",
          description: "true to grant approval, false to revoke. Defaults to true."
        },
        owner: {
          type: "string",
          description: "Wallet address that owns the LB shares. Used to pre-check isApprovedForAll and skip when the desired state is already set."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["operator"]
    },
    handler: wrapBuildHandler(buildSetLBApprovalForAll)
  },

  mantle_buildAaveSupply: {
    name: "mantle_buildAaveSupply",
    description:
      "Build an unsigned Aave V3 supply (deposit) transaction. Remember to approve the asset for the Pool contract first.\n\n" +
      "IMPORTANT: Only USDT0 is supported on Aave V3 — NOT USDT. If the user holds USDT, swap USDT → USDT0 on Merchant Moe first.\n\n" +
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
    handler: wrapBuildHandler(buildAaveSupply)
  },

  mantle_buildAaveBorrow: {
    name: "mantle_buildAaveBorrow",
    description:
      "Build an unsigned Aave V3 borrow transaction. Requires sufficient collateral deposited first.\n\n" +
      "IMPORTANT: Only USDT0 is supported on Aave V3 — NOT USDT. If the user wants to borrow Tether, use asset='USDT0'.\n\n" +
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
    handler: wrapBuildHandler(buildAaveBorrow)
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
    handler: wrapBuildHandler(buildAaveRepay)
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
    handler: wrapBuildHandler(buildAaveWithdraw)
  },

  mantle_buildAaveSetCollateral: {
    name: "mantle_buildAaveSetCollateral",
    description:
      "Build an unsigned Aave V3 transaction to enable or disable a supplied asset as collateral.\n\n" +
      "MSG.SENDER: This transaction operates on the SIGNING WALLET (msg.sender), not an " +
      "arbitrary address. The user param is only used for preflight diagnostics.\n\n" +
      "DIAGNOSTICS: When user is provided, runs on-chain checks before building the tx:\n" +
      "- Verifies aToken balance > 0 (user has actually supplied)\n" +
      "- Checks reserve config (LTV > 0, active, not frozen)\n" +
      "- Reads user config bitmap to detect if collateral is already enabled/disabled\n" +
      "- Returns a diagnostics object with the findings\n\n" +
      "If getUserAccountData shows totalCollateralBase=0 after a successful supply, " +
      "possible causes (checked in order):\n" +
      "1. Collateral flag not enabled → this tool fixes it\n" +
      "2. Reserve LTV=0 on-chain → tool will error with LTV_IS_ZERO\n" +
      "3. Oracle price=0 → collateral enabled but USD value is 0\n" +
      "4. Reserve not active → tool will error with RESERVE_NOT_ACTIVE\n\n" +
      "Examples:\n" +
      "- Enable WMNT as collateral: asset='WMNT', user='0x...' (user for diagnostics)\n" +
      "- Disable USDC as collateral: asset='USDC', user='0x...', use_as_collateral=false",
    inputSchema: {
      type: "object",
      properties: {
        asset: {
          type: "string",
          description: "Token symbol or address to enable/disable as collateral."
        },
        user: {
          type: "string",
          description:
            "Wallet address for preflight diagnostics (aToken balance, collateral status, " +
            "reserve config). NOT encoded into the tx — the tx always operates on msg.sender."
        },
        use_as_collateral: {
          type: "boolean",
          description: "true to enable as collateral (default), false to disable."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["asset"]
    },
    handler: wrapBuildHandler(buildAaveSetCollateral)
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
    handler: wrapBuildHandler(buildCollectFees)
  }
};
