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
import { ERC20_ABI } from "../lib/abis/erc20.js";
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
  listPairs,
  listAllPairs,
  type MoePair,
  type V3Pair
} from "../config/dex-pairs.js";

// ABIs
import { WMNT_ABI } from "../lib/abis/wmnt.js";
import { V3_SWAP_ROUTER_ABI, V3_POSITION_MANAGER_ABI } from "../lib/abis/uniswap-v3.js";
import { LB_ROUTER_ABI, LB_QUOTER_ABI, LB_FACTORY_ABI, LB_PAIR_ABI } from "../lib/abis/merchant-moe-lb.js";
import { AAVE_V3_POOL_ABI, AAVE_V3_WETH_GATEWAY_ABI } from "../lib/abis/aave-v3-pool.js";
import {
  discoverBestV3Pool as discoverBestV3PoolShared,
  type DiscoveredPool
} from "../lib/pool-discovery.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DEADLINE_SECONDS = 1200; // 20 minutes
const MAX_UINT256 = 2n ** 256n - 1n;

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
        "Then use WMNT for swaps, LP, and Aave.",
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

// ---------------------------------------------------------------------------
// Balance preflight helpers
// ---------------------------------------------------------------------------

/**
 * Check that `owner` holds at least `required` units of an ERC-20 token.
 * Throws INSUFFICIENT_BALANCE if not. Skips the check when required === MAX_UINT256
 * (e.g. amount='max' for repay/withdraw — the chain bounds it to actual debt/balance).
 * Callers should wrap this in a try/catch that re-throws only INSUFFICIENT_BALANCE
 * and swallows unrelated RPC failures (same pattern as the allowance checks).
 */
async function checkErc20Balance(
  client: ReturnType<typeof getPublicClient>,
  token: { address: string; symbol: string; decimals: number },
  required: bigint,
  owner: string
): Promise<void> {
  if (required === MAX_UINT256) return;
  const balance = (await client.readContract({
    address: token.address as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner as `0x${string}`]
  })) as bigint;
  if (balance < required) {
    const current = formatUnits(balance, token.decimals);
    const needed  = formatUnits(required, token.decimals);
    throw new MantleMcpError(
      "INSUFFICIENT_BALANCE",
      `${token.symbol} balance for ${owner} is ${current}, but this operation requires ${needed}.`,
      `Fund the wallet with at least ${needed} ${token.symbol}, or reduce the amount.`,
      { token: token.symbol, required: needed, current_balance: current, owner }
    );
  }
}

/**
 * Check that `owner` holds at least `required` native MNT.
 * Throws INSUFFICIENT_BALANCE if not.
 */
async function checkNativeBalance(
  client: ReturnType<typeof getPublicClient>,
  required: bigint,
  owner: string
): Promise<void> {
  const balance = await client.getBalance({ address: owner as `0x${string}` });
  if (balance < required) {
    const current = formatUnits(balance, 18);
    const needed  = formatUnits(required, 18);
    throw new MantleMcpError(
      "INSUFFICIENT_BALANCE",
      `MNT balance for ${owner} is ${current}, but this operation requires ${needed} MNT.`,
      `Fund the wallet with at least ${needed} MNT, or reduce the amount.`,
      { token: "MNT", required: needed, current_balance: current, owner }
    );
  }
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

      // Inject optional nonce override from caller args (must be a non-negative integer)
      const nonceArg =
        typeof args.nonce === "number" && Number.isInteger(args.nonce) && args.nonce >= 0
          ? args.nonce
          : null;
      if (nonceArg != null) {
        result.unsigned_tx.nonce = nonceArg;
      }

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
    /** Optional nonce override. Only present when caller explicitly provides a nonce
     *  (e.g. after querying mantle_getNonce to work around signer nonce issues). */
    nonce?: number;
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
   * This covers all builder call patterns (swaps, Aave, LP, etc.).
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
    router_address?: string;
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
  // "revoke" (or "0") sets allowance to zero; bypasses the positive-amount guard
  // and the "already sufficient" skip so approve(spender, 0) is always built.
  const isRevoke = args.amount === "revoke" || args.amount === "0";
  const amountRaw = args.amount === "max" || args.amount === "unlimited"
    ? MAX_UINT256
    : isRevoke
    ? 0n
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

  // If allowance is already sufficient, skip.
  // Never skip for revoke — approve(spender, 0) must always be built.
  if (!isRevoke && existingAllowance !== null && existingAllowance >= amountRaw) {
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
      : isRevoke
      ? "0 (revoke)"
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
    intent: isRevoke ? "approve_revoke" : "approve",
    human_summary: isRevoke
      ? `Revoke ${resolved.symbol} approval for ${spenderLabel} (set allowance to 0)`
      : `Approve ${amountDecimal} ${resolved.symbol} for ${spenderLabel}`,
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

  // ── Balance pre-check (blocking) ─────────────────────────────────────────
  const wrapSender = typeof args.sender === "string" && isAddress(args.sender, { strict: false })
    ? getAddress(args.sender)
    : null;
  const wrapWarnings: string[] = [];
  if (wrapSender) {
    try {
      const client = d.getClient(network);
      // Add a gas buffer: deposit() costs ~20k–30k gas. At 50k gas × 20 Gwei = 0.001 MNT
      // safety margin so a wallet with exactly `amount` MNT doesn't pass preflight
      // and then fail on broadcast with "insufficient funds for gas * price + value".
      const GAS_BUFFER_MNT = 50_000n * 20_000_000_000n;
      await checkNativeBalance(client, amountRaw + GAS_BUFFER_MNT, wrapSender);
    } catch (err) {
      if (err instanceof MantleMcpError && err.code === "INSUFFICIENT_BALANCE") throw err;
      wrapWarnings.push("Could not verify MNT balance (RPC error). Proceeding without balance check.");
    }
  }

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
    warnings: wrapWarnings,
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

  // ── Balance pre-check (blocking) ─────────────────────────────────────────
  const unwrapSender = typeof args.sender === "string" && isAddress(args.sender, { strict: false })
    ? getAddress(args.sender)
    : null;
  const unwrapWarnings: string[] = [];
  if (unwrapSender) {
    try {
      const client = d.getClient(network);
      const wmnt = wmntAddress(network);
      await checkErc20Balance(client, { address: wmnt, symbol: "WMNT", decimals: 18 }, amountRaw, unwrapSender);
    } catch (err) {
      if (err instanceof MantleMcpError && err.code === "INSUFFICIENT_BALANCE") throw err;
      unwrapWarnings.push("Could not verify WMNT balance (RPC error). Proceeding without balance check.");
    }
  }

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
    warnings: unwrapWarnings,
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

/**
 * Find a 2-hop V3 route via common bridge tokens using on-chain factory
 * discovery. Each leg's fee tier is auto-discovered by querying the V3
 * factory for all common fee tiers and selecting the pool with the
 * highest on-chain liquidity.
 *
 * This eliminates the need for a static pair registry — any token pair
 * with on-chain liquidity will be discovered automatically.
 */
async function findV3Route(
  provider: "agni" | "fluxion",
  tokenIn: ResolvedToken,
  tokenOut: ResolvedToken,
  network: Network,
  d: DefiWriteDeps
): Promise<V3Route | null> {
  const inAddr = tokenIn.address as `0x${string}`;
  const outAddr = tokenOut.address as `0x${string}`;

  interface RouteCandidate {
    bridgeSymbol: string;
    bridgeAddress: string;
    feeA: number;
    feeB: number;
    liquidityScore: bigint; // sum of both legs' liquidity for ranking
  }

  const candidates: Promise<RouteCandidate | null>[] = [];

  for (const [bridgeSymbol, bridgeAddr] of Object.entries(BRIDGE_TOKEN_ADDRESSES)) {
    const bridge = bridgeAddr as `0x${string}`;
    if (bridge.toLowerCase() === inAddr.toLowerCase()) continue;
    if (bridge.toLowerCase() === outAddr.toLowerCase()) continue;

    candidates.push(
      (async (): Promise<RouteCandidate | null> => {
        try {
          const [poolA, poolB] = await Promise.all([
            discoverBestV3Pool(provider, { address: inAddr, symbol: tokenIn.symbol, decimals: tokenIn.decimals }, { address: bridge, symbol: bridgeSymbol, decimals: 0 }, network, d),
            discoverBestV3Pool(provider, { address: bridge, symbol: bridgeSymbol, decimals: 0 }, { address: outAddr, symbol: tokenOut.symbol, decimals: tokenOut.decimals }, network, d)
          ]);
          if (!poolA || !poolB) return null;

          return {
            bridgeSymbol,
            bridgeAddress: bridgeAddr,
            feeA: poolA.feeTier,
            feeB: poolB.feeTier,
            liquidityScore: poolA.liquidity < poolB.liquidity ? poolA.liquidity : poolB.liquidity
          };
        } catch {
          return null;
        }
      })()
    );
  }

  const results = await Promise.all(candidates);
  let best: RouteCandidate | null = null;
  for (const r of results) {
    if (r && (best === null || r.liquidityScore > best.liquidityScore)) {
      best = r;
    }
  }

  if (!best) return null;

  return {
    tokens: [
      tokenIn,
      { address: best.bridgeAddress, symbol: best.bridgeSymbol, decimals: 0 },
      tokenOut
    ],
    fees: [best.feeA, best.feeB]
  };
}

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
      bin_step: quoterRoute.binSteps[0],
      router_address: routerAddress
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

  // ── Allowance pre-check (blocking) ───────────────────────────────
  // When an explicit owner/sender address is provided, read their allowance
  // for the router and ABORT if insufficient. This prevents the agent from
  // signing & broadcasting a swap that will revert with STF (SafeTransferFrom
  // failed) because the router has no approval to pull tokenIn.
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
      // Invariant: tokenIn is guaranteed to be an ERC-20 at this point.
      // Native MNT inputs are rejected upstream by resolveToken() before reaching
      // this block, so it is safe to call the ERC-20 `allowance(owner, spender)`.
      const allowance = await client.readContract({
        address: tokenIn.address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [swapOwner as `0x${string}`, routerAddress as `0x${string}`]
      }) as bigint;
      if (allowance < amountInRaw) {
        const allowanceDecimal = formatUnits(allowance, tokenIn.decimals);
        throw new MantleMcpError(
          "INSUFFICIENT_ALLOWANCE",
          `${tokenIn.symbol} allowance for ${provider} router (${routerAddress}) is ${allowanceDecimal}, ` +
          `but this swap requires ${amountInDecimal}. The transaction would revert on-chain with STF (SafeTransferFrom failed).`,
          `Approve the router first:\n` +
          `  mantle_buildApprove({ token: "${tokenIn.symbol}", spender: "${routerAddress}", amount: "${amountInDecimal}", owner: "${swapOwner}" })\n` +
          `Or via CLI:\n` +
          `  mantle-cli approve --token ${tokenIn.symbol} --spender ${routerAddress} --amount ${amountInDecimal} --owner ${swapOwner}`,
          { token: tokenIn.symbol, spender: routerAddress, required: amountInDecimal, current_allowance: allowanceDecimal, owner: swapOwner }
        );
      }
    } catch (err) {
      // Re-throw our own INSUFFICIENT_ALLOWANCE error only; swallow unrelated RPC failures.
      if (err instanceof MantleMcpError && err.code === "INSUFFICIENT_ALLOWANCE") throw err;
      // Non-critical RPC failure — proceed without allowance check
    }
    // ── Balance pre-check (blocking) ─────────────────────────────────
    try {
      const client = d.getClient(network);
      await checkErc20Balance(client, tokenIn, amountInRaw, swapOwner);
    } catch (err) {
      if (err instanceof MantleMcpError && err.code === "INSUFFICIENT_BALANCE") throw err;
      swapWarnings.push(`Could not verify ${tokenIn.symbol} balance (RPC error). Proceeding without balance check.`);
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
      }
    }

    if (feeTier !== undefined) {
      // Cross-validate against quote parameters if provided — ABORT on mismatch
      const quoteFeeTier = typeof args.quote_fee_tier === "number" ? args.quote_fee_tier : null;
      const quoteProvider = typeof args.quote_provider === "string" ? args.quote_provider : null;
      if (quoteFeeTier != null && quoteFeeTier !== feeTier) {
        throw new MantleMcpError(
          "QUOTE_BUILD_MISMATCH",
          `Quote used fee_tier ${quoteFeeTier} but build resolved fee_tier ${feeTier}. ` +
          `The minimum_out from your quote does not provide accurate slippage protection and the swap would likely result in significant losses.`,
          `Re-run mantle_getSwapQuote with provider='best' to get a fresh quote that matches the current best pool, then use the new minimum_out_raw.`,
          { quote_fee_tier: quoteFeeTier, build_fee_tier: feeTier, provider }
        );
      }
      if (quoteProvider != null && quoteProvider !== provider) {
        throw new MantleMcpError(
          "QUOTE_BUILD_MISMATCH",
          `Quote was from ${quoteProvider} but building on ${provider}. ` +
          `The minimum_out may not provide accurate slippage protection because different DEXes have different pricing.`,
          `Re-run mantle_getSwapQuote with provider='best' to get a fresh quote, then build with the winning provider.`,
          { quote_provider: quoteProvider, build_provider: provider }
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
      result.warnings.push(...swapWarnings);
      return result;
    }

    // No direct pair — try multi-hop via bridge token (on-chain discovery)
    const route = await findV3Route(provider, tokenIn, tokenOut, network, d);
    if (route) {
      // Cross-validate provider — ABORT if quote was from a different DEX
      const quoteProvider = typeof args.quote_provider === "string" ? args.quote_provider : null;
      if (quoteProvider != null && quoteProvider !== provider) {
        throw new MantleMcpError(
          "QUOTE_BUILD_MISMATCH",
          `Quote was from ${quoteProvider} but building on ${provider}. ` +
          `The minimum_out may not provide accurate slippage protection because different DEXes have different pricing.`,
          `Re-run mantle_getSwapQuote with provider='best' to get a fresh quote, then build with the winning provider.`,
          { quote_provider: quoteProvider, build_provider: provider }
        );
      }
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

    throw new MantleMcpError(
      "NO_ROUTE_FOUND",
      `No on-chain pool or multi-hop route found for ${tokenIn.symbol}/${tokenOut.symbol} on ${provider}. ` +
      `The V3 factory returned no pools with liquidity at any fee tier, and no 2-hop path via bridge tokens was viable.`,
      `Try: (1) Call mantle_getSwapQuote with provider='best' to check all DEXes. ` +
      `(2) Provide fee_tier explicitly if you know the pool parameters. ` +
      `Common fee tiers: 100 (0.01%), 500 (0.05%), 2500 (0.25%), 3000 (0.3%), 10000 (1%).`,
      { provider, tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol }
    );
  }

  // merchant_moe — resolve route:
  //   caller-explicit bin_step > LB Quoter on-chain discovery
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
        // Factory query failed — default to V1 routing (works for all pools)
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

    // Cross-validate against quote parameters — ABORT on mismatch
    const quoteBinStep = typeof args.quote_bin_step === "number" ? args.quote_bin_step : null;
    const quoteProvider = typeof args.quote_provider === "string" ? args.quote_provider : null;
    if (quoteBinStep != null && moeQuoterRoute.binSteps[0] !== quoteBinStep) {
      throw new MantleMcpError(
        "QUOTE_BUILD_MISMATCH",
        `Quote used bin_step ${quoteBinStep} but build resolved bin_step ${moeQuoterRoute.binSteps[0]}. ` +
        `The minimum_out from your quote does not provide accurate slippage protection and the swap would likely result in significant losses.`,
        `Re-run mantle_getSwapQuote with provider='best' to get a fresh quote that matches the current best pool, then use the new minimum_out_raw.`,
        { quote_bin_step: quoteBinStep, build_bin_step: moeQuoterRoute.binSteps[0], provider: "merchant_moe" }
      );
    }
    if (quoteProvider != null && quoteProvider !== "merchant_moe") {
      throw new MantleMcpError(
        "QUOTE_BUILD_MISMATCH",
        `Quote was from ${quoteProvider} but building on merchant_moe. ` +
        `The minimum_out may not provide accurate slippage protection because different DEXes have different pricing.`,
        `Re-run mantle_getSwapQuote with provider='best' to get a fresh quote, then build with the winning provider.`,
        { quote_provider: quoteProvider, build_provider: "merchant_moe" }
      );
    }

    result.warnings.push(...swapWarnings);
    return result;
  }

  // No route found via on-chain LB Quoter or explicit bin_step
  throw new MantleMcpError(
    "NO_ROUTE_FOUND",
    `No on-chain route found for ${tokenIn.symbol}/${tokenOut.symbol} on Merchant Moe. The LB Quoter could not discover a direct or multi-hop path with liquidity.`,
    `Try: (1) Call mantle_getSwapQuote with provider='best' to check all DEXes. ` +
    `(2) Provide bin_step explicitly if you know the pool parameters. ` +
    `Common bin steps: 1 (stablecoins), 2 (LSTs), 10-25 (volatile).`,
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
      fee_tier: feeTier,
      router_address: routerAddress
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
      router_version: routerVersion,
      router_address: routerAddress
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
      fee_tier: route.fees[0], // primary leg fee tier
      router_address: routerAddress
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

  // --- Range preset pre-resolution ---
  // Resolve range_preset into tick/bin bounds BEFORE USD amount mode,
  // because the V3 ratio calculation needs the final tick range.
  const RANGE_PRESETS: Record<string, number> = {
    aggressive: 5,
    moderate: 10,
    conservative: 20
  };
  const rangePreset = typeof args.range_preset === "string"
    ? args.range_preset.toLowerCase().trim()
    : null;
  if (rangePreset && !RANGE_PRESETS[rangePreset]) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `Invalid range_preset: '${rangePreset}'.`,
      "Use one of: 'aggressive' (±5%), 'moderate' (±10%), 'conservative' (±20%).",
      { range_preset: rangePreset }
    );
  }
  const rangePresetPct = rangePreset ? RANGE_PRESETS[rangePreset] : null;

  // For V3: pre-compute tick_lower/tick_upper from range_preset when not explicitly provided
  let resolvedTickLower: number | null = null;
  let resolvedTickUpper: number | null = null;
  // Cache the pool address resolved during range_preset to avoid a duplicate getPool call in USD mode (OPT-M-12).
  let resolvedPoolAddress: string | undefined;
  if ((provider === "agni" || provider === "fluxion") && rangePresetPct != null
      && typeof args.tick_lower !== "number" && typeof args.tick_upper !== "number") {
    const usedFeeTier = typeof args.fee_tier === "number" ? args.fee_tier : 3000;
    const client = d.getClient(network);
    const factoryAddress = getContractAddress(provider, "factory", network);
    const poolAddr = await client.readContract({
      address: factoryAddress as `0x${string}`,
      abi: [{ type: "function", name: "getPool", stateMutability: "view", inputs: [{ name: "", type: "address" }, { name: "", type: "address" }, { name: "", type: "uint24" }], outputs: [{ name: "", type: "address" }] }] as const,
      functionName: "getPool",
      args: [tokenA.address as `0x${string}`, tokenB.address as `0x${string}`, usedFeeTier]
    }) as `0x${string}`;

    if (!poolAddr || poolAddr === "0x0000000000000000000000000000000000000000") {
      throw new MantleMcpError(
        "POOL_NOT_FOUND",
        `Cannot use range_preset: No ${provider} pool found for ${tokenA.symbol}/${tokenB.symbol} at fee tier ${usedFeeTier}.`,
        "Verify the token pair and fee tier, or provide tick_lower/tick_upper explicitly.",
        { token_a: tokenA.symbol, token_b: tokenB.symbol, fee_tier: usedFeeTier, provider }
      );
    }

    // Cache for reuse in USD mode (avoids duplicate RPC call)
    resolvedPoolAddress = poolAddr;

    const [slot0Raw, tickSpacingRaw] = await Promise.all([
      client.readContract({
        address: poolAddr,
        abi: [{ type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [{ name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" }, { name: "", type: "uint16" }, { name: "", type: "uint16" }, { name: "", type: "uint16" }, { name: "", type: "uint8" }, { name: "", type: "bool" }] }] as const,
        functionName: "slot0"
      }) as Promise<readonly [bigint, number, ...unknown[]]>,
      client.readContract({
        address: poolAddr,
        abi: [{ type: "function", name: "tickSpacing", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "int24" }] }] as const,
        functionName: "tickSpacing"
      }) as Promise<number>
    ]);

    const currentTick = slot0Raw[1];
    const tickSpacing = Number(tickSpacingRaw);

    const tickOffsetUp = Math.floor(Math.log(1 + rangePresetPct / 100) / Math.log(1.0001));
    // Use Math.ceil for the downward offset (negative value) so the lower bound
    // is rounded toward zero, keeping the range within the stated ±X% preset.
    const tickOffsetDown = Math.ceil(Math.log(1 - rangePresetPct / 100) / Math.log(1.0001));

    resolvedTickLower = Math.floor((currentTick + tickOffsetDown) / tickSpacing) * tickSpacing;
    resolvedTickUpper = Math.ceil((currentTick + tickOffsetUp) / tickSpacing) * tickSpacing;

    // Clamp to V3 valid tick range (OPT-M-11)
    const MIN_TICK = -887272;
    const MAX_TICK = 887272;
    resolvedTickLower = Math.max(MIN_TICK, resolvedTickLower);
    resolvedTickUpper = Math.min(MAX_TICK, resolvedTickUpper);
    if (resolvedTickLower >= resolvedTickUpper) {
      warnings.push("range_preset produced invalid tick range after clamping; falling back to full range.");
      resolvedTickLower = -887220;
      resolvedTickUpper = 887220;
    }

    warnings.push(
      `range_preset '${rangePreset}' (±${rangePresetPct}%): computed tick range [${resolvedTickLower}, ${resolvedTickUpper}] ` +
      `from current tick ${currentTick} (tick spacing ${tickSpacing}).`
    );
  }

  // Helper: get the effective tick bounds (explicit > range_preset > full range)
  const effectiveTickLower = typeof args.tick_lower === "number" ? args.tick_lower
    : resolvedTickLower != null ? resolvedTickLower : -887220;
  const effectiveTickUpper = typeof args.tick_upper === "number" ? args.tick_upper
    : resolvedTickUpper != null ? resolvedTickUpper : 887220;

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
      const tickLower = effectiveTickLower;
      const tickUpper = effectiveTickUpper;
      // tickSpacing-agnostic: any tick near the pool's MIN/MAX counts as full
      // range (Uniswap vanilla is ±887220 at tickSpacing 60; Agni's fee-tier
      // pools use ±887200 / ±887250 / ±887270 depending on spacing).
      const isFullRange = tickLower <= -800000 && tickUpper >= 800000;

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
          // Reuse pool address from range_preset resolution if available (avoids duplicate getPool RPC call)
          const poolAddr: `0x${string}` = resolvedPoolAddress
            ? resolvedPoolAddress as `0x${string}`
            : await client.readContract({
                address: getContractAddress(provider, "factory", network) as `0x${string}`,
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

  // Resolve the contract that needs ERC-20 approval:
  //   V3 (agni/fluxion) → position manager
  //   Merchant Moe LB   → LB router v2.2
  const spenderKey = (provider === "agni" || provider === "fluxion")
    ? "position_manager"
    : "lb_router_v2_2";
  const spenderAddress = getContractAddress(provider, spenderKey, network);

  // Blocking allowance check (same pattern as buildSwap / cecb96a)
  const lpOwner = typeof args.owner === "string" && isAddress(args.owner, { strict: false })
    ? getAddress(args.owner)
    : null;

  if (lpOwner) {
    try {
      const client = d.getClient(network);
      // Native MNT never reaches this block — resolveToken() upstream rejects the
      // zero/native pseudo-address, so tokenA/tokenB are guaranteed to be ERC-20.
      // Use allSettled so that a single non-standard-ERC20 rejection does NOT
      // mask the other token's *known*-insufficient allowance (which would
      // otherwise reopen the STF-revert path this throw is designed to close).
      const settled = await Promise.allSettled([
        client.readContract({
          address: tokenA.address as `0x${string}`,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [lpOwner as `0x${string}`, spenderAddress as `0x${string}`]
        }) as Promise<bigint>,
        client.readContract({
          address: tokenB.address as `0x${string}`,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [lpOwner as `0x${string}`, spenderAddress as `0x${string}`]
        }) as Promise<bigint>
      ]);

      const tokens = [
        { sym: tokenA.symbol, required: amountARaw, requiredDec: amountADecimal, decimals: tokenA.decimals, result: settled[0] },
        { sym: tokenB.symbol, required: amountBRaw, requiredDec: amountBDecimal, decimals: tokenB.decimals, result: settled[1] }
      ] as const;

      for (const t of tokens) {
        if (t.result.status === "rejected") {
          warnings.push(
            `Could not read ${t.sym} allowance (RPC error). Proceeding without blocking check — the swap may revert with STF if allowance is insufficient.`
          );
          continue;
        }
        const allowance = t.result.value;
        if (allowance < t.required) {
          const currentDec = formatUnits(allowance, t.decimals);
          throw new MantleMcpError(
            "INSUFFICIENT_ALLOWANCE",
            `${t.sym} allowance for ${provider} (${spenderAddress}) is ${currentDec}, ` +
            `but this add-liquidity requires ${t.requiredDec}. The transaction would revert on-chain with STF (SafeTransferFrom failed).`,
            `Approve the spender first:\n` +
            `  mantle_buildApprove({ token: "${t.sym}", spender: "${spenderAddress}", amount: "${t.requiredDec}", owner: "${lpOwner}" })\n` +
            `Or via CLI:\n` +
            `  mantle-cli approve --token ${t.sym} --spender ${spenderAddress} --amount ${t.requiredDec} --owner ${lpOwner}`,
            { token: t.sym, spender: spenderAddress, required: t.requiredDec, current_allowance: currentDec, owner: lpOwner }
          );
        }
      }
    } catch (err) {
      // Re-throw our own INSUFFICIENT_ALLOWANCE only; swallow unrelated RPC failures.
      if (err instanceof MantleMcpError && err.code === "INSUFFICIENT_ALLOWANCE") throw err;
    }
    // ── Balance pre-check (blocking) ─────────────────────────────────
    const client = d.getClient(network);
    const balTokens = [
      { sym: tokenA.symbol, check: checkErc20Balance(client, tokenA, amountARaw, lpOwner) },
      { sym: tokenB.symbol, check: checkErc20Balance(client, tokenB, amountBRaw, lpOwner) }
    ];
    const balSettled = await Promise.allSettled(balTokens.map(t => t.check));
    for (let i = 0; i < balSettled.length; i++) {
      const result = balSettled[i];
      if (result.status === "rejected") {
        const err = result.reason;
        if (err instanceof MantleMcpError && err.code === "INSUFFICIENT_BALANCE") throw err;
        warnings.push(
          `Could not verify ${balTokens[i].sym} balance (RPC error). Proceeding without balance check — the tx may revert if balance is insufficient.`
        );
      }
    }
  }

  if (provider === "agni" || provider === "fluxion") {
    const usedFeeTier = typeof args.fee_tier === "number" ? args.fee_tier : 3000;

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
      feeTier: usedFeeTier,
      tickLower: effectiveTickLower,
      tickUpper: effectiveTickUpper,
      now: d.now()
    });
    result.warnings.push(...warnings);
    result.pool_params = {
      provider,
      fee_tier: usedFeeTier,
      router_address: spenderAddress
    };
    return result;
  }

  // merchant_moe LB
  const binStep = typeof args.bin_step === "number" ? args.bin_step : 25;

  // When range_preset is provided, compute deltaIds spread from percentage.
  // LB bin price ratio ≈ 1 + binStep/10000, so for ±X% range:
  //   numBins = ceil(log(1 + X/100) / log(1 + binStep/10000))
  let computedDeltaIds: number[] | null = null;
  if (rangePresetPct != null && !Array.isArray(args.delta_ids)) {
    const binPriceRatio = 1 + binStep / 10000;
    const MAX_HALF_SPREAD = 50; // Cap to avoid enormous arrays for low-binStep pools
    const rawHalfSpread = Math.max(1, Math.ceil(Math.log(1 + rangePresetPct / 100) / Math.log(binPriceRatio)));
    const halfSpread = Math.min(rawHalfSpread, MAX_HALF_SPREAD);
    computedDeltaIds = [];
    for (let i = -halfSpread; i <= halfSpread; i++) computedDeltaIds.push(i);
    if (rawHalfSpread > MAX_HALF_SPREAD) {
      warnings.push(
        `range_preset '${rangePreset}' (±${rangePresetPct}%) would require ${rawHalfSpread * 2 + 1} bins for bin step ${binStep} — ` +
        `capped to ${MAX_HALF_SPREAD * 2 + 1} bins (±${MAX_HALF_SPREAD}) to stay within gas limits. ` +
        `For wider ranges on low-binStep pools, provide explicit delta_ids.`
      );
    }
    warnings.push(
      `range_preset '${rangePreset}' (±${rangePresetPct}%): computed ${computedDeltaIds.length} bins ` +
      `(delta ${computedDeltaIds[0]} to ${computedDeltaIds[computedDeltaIds.length - 1]}) for bin step ${binStep}.`
    );
  }

  const result = await buildMoeAddLiquidity({
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
    activeIdOverride:
      typeof args.active_id === "number" ? args.active_id : null,
    idSlippage: typeof args.id_slippage === "number" ? args.id_slippage : 5,
    deltaIds: Array.isArray(args.delta_ids)
      ? (args.delta_ids as number[])
      : computedDeltaIds,
    distributionX: Array.isArray(args.distribution_x)
      ? (args.distribution_x as number[])
      : null,
    distributionY: Array.isArray(args.distribution_y)
      ? (args.distribution_y as number[])
      : null,
    now: d.now(),
    deps: d
  });
  result.warnings.push(...warnings);
  result.pool_params = {
    provider: "merchant_moe",
    bin_step: binStep,
    router_address: spenderAddress
  };
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

  const providerLabel = provider === "agni" ? "Agni" : "Fluxion";
  const warnings: string[] = [];
  const swLp = sepoliaWarning(network);
  if (swLp) warnings.push(swLp);

  // Pool-state-aware amountMin computation.
  //
  // V3 mint() pulls amounts proportional to L = min(L0, L1) at the current
  // price, capped by the caller's (amount0Desired, amount1Desired). When the
  // caller's amounts don't match the pool's ratio at the requested tick range,
  // the un-binding side is under-consumed; an amountMin derived from
  // `desired * (1 - slippage)` on that side reverts with "Price slippage
  // check" every time.
  //
  // Fix: read slot0, compute the amounts the pool will ACTUALLY pull, and
  // base amountMin on those. Desired stays as the caller's ceiling. If the
  // RPC read fails, fall back to the legacy amountMin-from-desired path and
  // emit a warning so the caller isn't silently unprotected.
  let amount0MinBase = amount0Desired;
  let amount1MinBase = amount1Desired;
  let poolStateResolved = false;

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
      const [slot0, tickSpacingRaw] = await Promise.all([
        client.readContract({
          address: poolAddr,
          abi: [{ type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [{ name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" }, { name: "", type: "uint16" }, { name: "", type: "uint16" }, { name: "", type: "uint16" }, { name: "", type: "uint8" }, { name: "", type: "bool" }] }] as const,
          functionName: "slot0"
        }) as Promise<readonly [bigint, number, ...unknown[]]>,
        client.readContract({
          address: poolAddr,
          abi: [{ type: "function", name: "tickSpacing", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "int24" }] }] as const,
          functionName: "tickSpacing"
        }) as Promise<number>
      ]);

      const sqrtPriceX96 = slot0[0];
      const currentTick = slot0[1];
      const tickSpacing = Number(tickSpacingRaw);

      // Full-range detection is tickSpacing-aware: each pool caps usable ticks
      // at Math.floor(MAX_TICK / tickSpacing) * tickSpacing, not the Uniswap
      // vanilla -887220/887220.
      const MAX_TICK = 887272;
      const maxUsable = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
      if (tickLower === -maxUsable && tickUpper === maxUsable) {
        warnings.push(
          "Using full-range tick bounds (MIN_TICK to MAX_TICK). Consider narrower range for concentrated liquidity."
        );
      }

      if (currentTick < tickLower || currentTick >= tickUpper) {
        warnings.push(
          `OUT-OF-RANGE WARNING: Current pool tick is ${currentTick}, but your range is [${tickLower}, ${tickUpper}]. ` +
          `This position will NOT earn any trading fees until the price moves into your range. ` +
          `Consider using mantle-cli lp suggest-ticks to get recommended tick ranges.`
        );
      }

      // V3 price math in float. sqrtP = sqrtPriceX96 / 2^96;
      // sqrtPLower/Upper = sqrt(1.0001 ^ tick) = 1.0001 ^ (tick/2).
      const sqrtP = Number(sqrtPriceX96) / 2 ** 96;
      const sqrtPLower = Math.pow(1.0001, tickLower / 2);
      const sqrtPUpper = Math.pow(1.0001, tickUpper / 2);
      const sqrtPClamped = Math.max(sqrtPLower, Math.min(sqrtPUpper, sqrtP));

      // Per-unit-liquidity amounts for (sqrtPClamped, sqrtPLower, sqrtPUpper).
      // Collapses below/within/above-range cases.
      const perL0 = sqrtPClamped <= sqrtPLower
        ? (1 / sqrtPLower) - (1 / sqrtPUpper)
        : (1 / sqrtPClamped) - (1 / sqrtPUpper);
      const perL1 = sqrtPClamped >= sqrtPUpper
        ? sqrtPUpper - sqrtPLower
        : sqrtPClamped - sqrtPLower;

      const amount0Num = Number(amount0Desired);
      const amount1Num = Number(amount1Desired);
      const L0 = perL0 > 0 ? amount0Num / perL0 : Infinity;
      const L1 = perL1 > 0 ? amount1Num / perL1 : Infinity;
      const L = Math.min(L0, L1);

      const expAmount0 = BigInt(Math.max(0, Math.floor(L * perL0)));
      const expAmount1 = BigInt(Math.max(0, Math.floor(L * perL1)));

      // Imbalance warning (>1% un-consumed on either side). The excess is NOT
      // lost — it stays in the caller's wallet — but it signals that amounts
      // were not sized for this pool's current ratio.
      const imbalanceThresholdBps = 100n;
      const isImbalanced =
        (amount0Desired > 0n &&
          expAmount0 * 10000n < amount0Desired * (10000n - imbalanceThresholdBps)) ||
        (amount1Desired > 0n &&
          expAmount1 * 10000n < amount1Desired * (10000n - imbalanceThresholdBps));
      if (isImbalanced) {
        const exp0Dec = formatUnits(expAmount0, token0.decimals);
        const exp1Dec = formatUnits(expAmount1, token1.decimals);
        warnings.push(
          `UNBALANCED amounts for current pool price: supplied ` +
          `${amt0Label} ${token0.symbol} + ${amt1Label} ${token1.symbol}, but only ` +
          `~${exp0Dec} ${token0.symbol} + ~${exp1Dec} ${token1.symbol} will be minted ` +
          `at the current tick (${currentTick}) within [${tickLower}, ${tickUpper}]. ` +
          `The excess stays in your wallet; consider adjusting amounts to match the ` +
          `pool ratio for better capital efficiency.`
        );
      }

      // amountMin is derived from the expected actual pull, not from desired —
      // this is what lets imbalanced inputs pass the on-chain slippage check.
      amount0MinBase = expAmount0;
      amount1MinBase = expAmount1;
      poolStateResolved = true;
    }
  } catch {
    // Non-critical — fall back to legacy amountMin-from-desired below.
  }

  if (!poolStateResolved) {
    warnings.push(
      "Could not read pool state to balance amounts — falling back to amountMin " +
      "derived from desired amounts. If desired amounts don't match the pool's " +
      "current price/tick ratio, mint() may revert with 'Price slippage check'."
    );
  }

  const amount0Min = (amount0MinBase * BigInt(10000 - slippageBps)) / 10000n;
  const amount1Min = (amount1MinBase * BigInt(10000 - slippageBps)) / 10000n;

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

async function buildMoeAddLiquidity(params: {
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
  activeIdOverride: number | null;
  idSlippage: number;
  deltaIds: number[] | null;
  distributionX: number[] | null;
  distributionY: number[] | null;
  now: string;
  deps: DefiWriteDeps;
}): Promise<UnsignedTxResult> {
  const {
    tokenA,
    tokenB,
    slippageBps,
    recipient,
    deadline,
    network,
    binStep,
    activeIdOverride,
    idSlippage,
    now,
    deps
  } = params;

  const routerAddress = getContractAddress(
    "merchant_moe",
    "lb_router_v2_2",
    network
  );

  const warnings: string[] = [];

  // ── Step 1: Resolve LBPair and read on-chain state ──────────────────
  const client = deps.getClient(network);
  const factoryAddr = getContractAddress("merchant_moe", "lb_factory_v2_2", network) as `0x${string}`;

  const pairInfo = await client.readContract({
    address: factoryAddr,
    abi: LB_FACTORY_ABI,
    functionName: "getLBPairInformation",
    args: [
      tokenA.address as `0x${string}`,
      tokenB.address as `0x${string}`,
      BigInt(binStep)
    ]
  }) as { binStep: number; LBPair: string; createdByOwner: boolean; ignoredForRouting: boolean };

  if (!pairInfo.LBPair || pairInfo.LBPair === "0x0000000000000000000000000000000000000000") {
    throw new MantleMcpError(
      "POOL_NOT_FOUND",
      `No Merchant Moe LB pair found for ${tokenA.symbol}/${tokenB.symbol} with bin step ${binStep}.`,
      "Use 'mantle-cli lp find-pools --token-a <A> --token-b <B>' to discover available pools and their bin steps.",
      { token_a: tokenA.symbol, token_b: tokenB.symbol, bin_step: binStep }
    );
  }

  const pairAddr = pairInfo.LBPair as `0x${string}`;

  // Read active bin ID and canonical tokenX from the pair contract
  const [activeIdRaw, pairTokenX] = await Promise.all([
    client.readContract({
      address: pairAddr,
      abi: LB_PAIR_ABI,
      functionName: "getActiveId"
    }) as Promise<number>,
    client.readContract({
      address: pairAddr,
      abi: LB_PAIR_ABI,
      functionName: "getTokenX"
    }) as Promise<`0x${string}`>
  ]);

  const activeIdDesired = activeIdOverride ?? Number(activeIdRaw);
  if (activeIdOverride == null) {
    warnings.push(
      `Auto-resolved active bin ID from on-chain: ${activeIdDesired} (pair: ${pairAddr.slice(0, 10)}...).`
    );
  }

  // ── Step 2: Sort tokens to match the pair's canonical order ─────────
  // LB pairs have a fixed tokenX (lower address) / tokenY (higher address)
  // ordering. The router reverts with LBRouter__WrongTokenOrder if mismatched.
  const tokenAIsX = tokenA.address.toLowerCase() === pairTokenX.toLowerCase();
  const tokenBIsX = tokenB.address.toLowerCase() === pairTokenX.toLowerCase();
  if (!tokenAIsX && !tokenBIsX) {
    throw new MantleMcpError(
      "TOKEN_MISMATCH",
      `LB pair tokenX (${pairTokenX}) matches neither ${tokenA.symbol} (${tokenA.address}) nor ${tokenB.symbol} (${tokenB.address}). The pair was found but its token composition is unexpected.`,
      "Re-check token addresses and bin step. The pair may be misconfigured.",
      { pair: pairAddr, pairTokenX, tokenA: tokenA.address, tokenB: tokenB.address }
    );
  }
  const [tokenX, tokenY, amountXRaw, amountYRaw, amountXDecimal, amountYDecimal] = tokenAIsX
    ? [tokenA, tokenB, params.amountARaw, params.amountBRaw, params.amountADecimal, params.amountBDecimal]
    : [tokenB, tokenA, params.amountBRaw, params.amountARaw, params.amountBDecimal, params.amountADecimal];

  const amountXMin = (amountXRaw * BigInt(10000 - slippageBps)) / 10000n;
  const amountYMin = (amountYRaw * BigInt(10000 - slippageBps)) / 10000n;

  // ── Step 3: Resolve distribution (user-provided or auto-generate) ───
  let deltaIds: number[];
  let distributionX: number[];
  let distributionY: number[];

  if (params.deltaIds != null && params.distributionX != null && params.distributionY != null) {
    // User explicitly provided all three — use as-is
    deltaIds = params.deltaIds;
    distributionX = params.distributionX;
    distributionY = params.distributionY;

    // Validate array lengths match
    if (deltaIds.length !== distributionX.length || deltaIds.length !== distributionY.length) {
      throw new MantleMcpError(
        "INVALID_INPUT",
        `delta_ids (${deltaIds.length}), distribution_x (${distributionX.length}), and distribution_y (${distributionY.length}) must have the same length.`,
        "Provide arrays of equal length for all three distribution parameters.",
        { delta_ids_len: deltaIds.length, dist_x_len: distributionX.length, dist_y_len: distributionY.length }
      );
    }

    // Validate distribution sums.
    // The LB router enforces sum <= 1e18 per token, but allows sum == 0 when the
    // corresponding amount is also 0 (one-sided deposits are a first-class use case).
    const ONE_E18 = BigInt("1000000000000000000");
    const TOLERANCE = 1000n; // allow minor float-rounding drift from JS callers
    const sumX = distributionX.reduce((a, b) => a + BigInt(Math.floor(b)), 0n);
    const sumY = distributionY.reduce((a, b) => a + BigInt(Math.floor(b)), 0n);

    const xExpectsNonZero = amountXRaw > 0n;
    const yExpectsNonZero = amountYRaw > 0n;
    const xDrift = sumX > ONE_E18 ? sumX - ONE_E18 : ONE_E18 - sumX;
    const yDrift = sumY > ONE_E18 ? sumY - ONE_E18 : ONE_E18 - sumY;

    const xInvalid = xExpectsNonZero ? xDrift > TOLERANCE : sumX !== 0n;
    const yInvalid = yExpectsNonZero ? yDrift > TOLERANCE : sumY !== 0n;

    if (xInvalid || yInvalid) {
      throw new MantleMcpError(
        "INVALID_INPUT",
        `Distribution sum mismatch: distribution_x sums to ${sumX} (expected ${xExpectsNonZero ? "~1e18" : "0"}), ` +
        `distribution_y sums to ${sumY} (expected ${yExpectsNonZero ? "~1e18" : "0"}).`,
        "Each distribution array must sum to 1e18 when the corresponding token amount is non-zero, " +
        "or 0 when the token amount is 0 (one-sided deposit).",
        { sum_x: sumX.toString(), sum_y: sumY.toString(), amount_x: amountXRaw.toString(), amount_y: amountYRaw.toString() }
      );
    }
  } else {
    if (params.deltaIds != null && params.distributionX == null && params.distributionY == null) {
      // deltaIds provided but no distributions — auto-generate uniform distribution
      // for the provided deltaIds (e.g. from range_preset)
      deltaIds = params.deltaIds;
    } else if (params.deltaIds != null || params.distributionX != null || params.distributionY != null) {
      // Some but not all distribution params provided — warn and use default deltaIds
      warnings.push(
        "Partial distribution parameters provided (need all three: delta_ids, distribution_x, distribution_y). " +
        "Using auto-generated uniform distribution instead."
      );
      // Auto-generate default ±3 bins
      const HALF_SPREAD = 3;
      deltaIds = [];
      for (let i = -HALF_SPREAD; i <= HALF_SPREAD; i++) deltaIds.push(i);
    } else {
      // No distribution params at all — use default ±3 bins
      const HALF_SPREAD = 3;
      deltaIds = [];
      for (let i = -HALF_SPREAD; i <= HALF_SPREAD; i++) deltaIds.push(i);
    }

    // Auto-generate a uniform "spot" distribution for the deltaIds.
    // LB convention:
    //   - bins above active (positive delta): hold only tokenX
    //   - bins below active (negative delta): hold only tokenY
    //   - active bin (delta 0): holds both tokenX and tokenY
    const numBinsX = deltaIds.filter(d => d >= 0).length; // active + above
    const numBinsY = deltaIds.filter(d => d <= 0).length; // below + active

    // Compute per-bin fractions (must sum to exactly 1e18 = 100%)
    // Use BigInt arithmetic throughout to avoid float64 precision errors for
    // values > 2^53 (OPT-M-10). Only convert to Number at the end for the
    // distribution arrays (which expect number[]).
    const ONE_E18 = 1000000000000000000n;
    const fracXBig = numBinsX > 0 ? ONE_E18 / BigInt(numBinsX) : 0n;
    const fracYBig = numBinsY > 0 ? ONE_E18 / BigInt(numBinsY) : 0n;
    // Put rounding remainder in the active bin (delta 0)
    const remainderXBig = numBinsX > 0 ? ONE_E18 - fracXBig * BigInt(numBinsX) : 0n;
    const remainderYBig = numBinsY > 0 ? ONE_E18 - fracYBig * BigInt(numBinsY) : 0n;

    distributionX = [];
    distributionY = [];
    for (const delta of deltaIds) {
      // tokenX: active bin + bins above active
      if (delta >= 0) {
        distributionX.push(Number(delta === 0 ? fracXBig + remainderXBig : fracXBig));
      } else {
        distributionX.push(0);
      }
      // tokenY: bins below active + active bin
      if (delta <= 0) {
        distributionY.push(Number(delta === 0 ? fracYBig + remainderYBig : fracYBig));
      } else {
        distributionY.push(0);
      }
    }

    warnings.push(
      `Auto-generated uniform distribution across ${deltaIds.length} bins ` +
      `(delta ${deltaIds[0]} to ${deltaIds[deltaIds.length - 1]}) around active bin ${activeIdDesired}.`
    );
  }

  // ── Step 4: Build calldata ──────────────────────────────────────────
  const liquidityParameters = {
    tokenX: tokenX.address as `0x${string}`,
    tokenY: tokenY.address as `0x${string}`,
    binStep: BigInt(binStep),
    amountX: amountXRaw,
    amountY: amountYRaw,
    amountXMin,
    amountYMin,
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
    human_summary: `Add liquidity on Merchant Moe LB: ${amountXDecimal} ${tokenX.symbol} (X) + ${amountYDecimal} ${tokenY.symbol} (Y) (bin step: ${binStep}, active bin: ${activeIdDesired}, bins: ${deltaIds.length})`,
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
          "Verify the position on https://agni.finance or Mantlescan (tx history for the NonfungiblePositionManager NFT).",
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
    // V3 removeLiquidity is called on the NonfungiblePositionManager NFT owner path
    // and requires no ERC-20 allowance — intentionally omit `router_address` so
    // agents do not construct a spurious `mantle_buildApprove` against the position
    // manager. The provider alone is sufficient context for callers.
    result.pool_params = {
      provider
    };
    return result;
  }

  // Merchant Moe
  const tokenAInput = requireString(args.token_a, "token_a");
  const tokenBInput = requireString(args.token_b, "token_b");
  const tokenA = await resolveToken(d, tokenAInput, network);
  const tokenB = await resolveToken(d, tokenBInput, network);

  const routerAddress = getContractAddress(
    "merchant_moe",
    "lb_router_v2_2",
    network
  );
  const binStep =
    typeof args.bin_step === "number" ? args.bin_step : 25;

  const warnings: string[] = [];

  // ── Step 1: Resolve LBPair and read canonical token order ───────────
  // LB pairs have a fixed tokenX/tokenY ordering. The router reverts with
  // LBRouter__WrongTokenOrder if the caller passes them in the wrong order.
  const client = d.getClient(network);
  const factoryAddr = getContractAddress("merchant_moe", "lb_factory_v2_2", network) as `0x${string}`;
  const pairInfo = await client.readContract({
    address: factoryAddr,
    abi: LB_FACTORY_ABI,
    functionName: "getLBPairInformation",
    args: [
      tokenA.address as `0x${string}`,
      tokenB.address as `0x${string}`,
      BigInt(binStep)
    ]
  }) as { LBPair: string };

  if (!pairInfo.LBPair || pairInfo.LBPair === "0x0000000000000000000000000000000000000000") {
    throw new MantleMcpError(
      "POOL_NOT_FOUND",
      `No Merchant Moe LB pair found for ${tokenA.symbol}/${tokenB.symbol} with bin step ${binStep}.`,
      "Use 'mantle-cli lp find-pools --token-a <A> --token-b <B>' to discover available pools and their bin steps.",
      { token_a: tokenA.symbol, token_b: tokenB.symbol, bin_step: binStep }
    );
  }

  const pairAddr = pairInfo.LBPair as `0x${string}`;
  const pairTokenX = await client.readContract({
    address: pairAddr,
    abi: LB_PAIR_ABI,
    functionName: "getTokenX"
  }) as `0x${string}`;

  // Sort tokens to match the pair's canonical order (same as addLiquidity)
  const tokenAIsX = tokenA.address.toLowerCase() === pairTokenX.toLowerCase();
  const tokenBIsX = tokenB.address.toLowerCase() === pairTokenX.toLowerCase();
  if (!tokenAIsX && !tokenBIsX) {
    throw new MantleMcpError(
      "TOKEN_MISMATCH",
      `LB pair tokenX (${pairTokenX}) matches neither ${tokenA.symbol} (${tokenA.address}) nor ${tokenB.symbol} (${tokenB.address}).`,
      "Re-check token addresses and bin step.",
      { pair: pairAddr, pairTokenX, tokenA: tokenA.address, tokenB: tokenB.address }
    );
  }
  const [tokenX, tokenY] = tokenAIsX
    ? [tokenA, tokenB]
    : [tokenB, tokenA];

  // ── Step 2: Determine bin IDs and amounts ───────────────────────────
  let ids: bigint[];
  let amounts: bigint[];

  // Percentage mode: read on-chain LP balances and compute amounts automatically
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

    // Guard against sub-0.005% which rounds the multiplier to 0
    if (pct < 100 && Math.round(pct * 100) === 0) {
      throw new MantleMcpError(
        "INVALID_INPUT",
        `percentage ${pct} is too small — rounds to 0 effective removal. Minimum effective percentage is ~0.01.`,
        "Use a percentage >= 0.01, or use explicit ids+amounts for sub-basis-point precision.",
        { percentage: pct }
      );
    }

    // If bin IDs are explicitly provided, use those; otherwise scan ±25 around active bin
    let binIdsToCheck: number[];
    if (Array.isArray(args.ids) && args.ids.length > 0) {
      binIdsToCheck = (args.ids as (number | string)[]).map(Number);
    } else {
      // Auto-scan: get active bin and check ±25 range for user balances
      const activeId = await client.readContract({
        address: pairAddr,
        abi: LB_PAIR_ABI,
        functionName: "getActiveId"
      }) as number;
      const BIN_SCAN_RADIUS = 25;
      binIdsToCheck = [];
      for (let offset = -BIN_SCAN_RADIUS; offset <= BIN_SCAN_RADIUS; offset++) {
        const binId = Number(activeId) + offset;
        if (binId >= 0) binIdsToCheck.push(binId);
      }
    }

    // Read user LP balances for all candidate bins via multicall
    // Use owner (the LP token holder / signer) if provided; fall back to recipient.
    // The LP tokens are held by the signer, not the recipient — these may differ.
    const lpHolder = args.owner
      ? requireAddress(args.owner, "owner")
      : recipient;
    const balanceCalls = binIdsToCheck.map((id) => ({
      address: pairAddr,
      abi: LB_PAIR_ABI,
      functionName: "balanceOf" as const,
      args: [lpHolder, BigInt(id)]
    }));
    const balanceResults = await client.multicall({ contracts: balanceCalls });

    ids = [];
    amounts = [];
    for (let i = 0; i < binIdsToCheck.length; i++) {
      const result = balanceResults[i];
      if (result.status !== "success") continue;
      const balance = result.result as bigint;
      if (balance === 0n) continue;

      const amountToRemove = pct === 100
        ? balance
        : (() => {
            const multiplier = BigInt(Math.round(pct * 100));
            if (multiplier === 0n) return 0n; // guarded below after loop
            return (balance * multiplier) / 10000n;
          })();
      if (amountToRemove === 0n) continue;

      ids.push(BigInt(binIdsToCheck[i]));
      amounts.push(amountToRemove);
    }

    if (ids.length === 0) {
      const holderHint = lpHolder !== recipient
        ? ` LP balances were queried for ${lpHolder} (--owner).`
        : ` If the LP tokens are held by a different address (e.g. the transaction signer), provide owner=<signer-address>.`;
      throw new MantleMcpError(
        "INVALID_INPUT",
        `No LP token balance found in any scanned bins for ${lpHolder}.${holderHint}`,
        "Verify the address has LP positions in this pair. Use mantle_getLBPositions to check.",
        { pair: pairAddr, lp_holder: lpHolder, recipient, bin_step: binStep }
      );
    }

    const scanNote = !(Array.isArray(args.ids) && args.ids.length > 0)
      ? pct === 100
        ? ` ⚠️ Auto-scanned ±25 bins around active price for percentage=100 (full removal). Positions in distant bins will NOT be removed. Run mantle_getLBPositions first to confirm all bin positions, then supply explicit ids for complete removal.`
        : ` Auto-scanned ±25 bins around active price; if you have positions in distant bins, supply explicit ids or use mantle_getLBPositions to locate all bins first.`
      : "";
    warnings.push(
      `Percentage mode: removing ${pct}% from ${ids.length} bins (LP token balances read on-chain at tx build time).${scanNote}`
    );
  } else {
    // Explicit ids + amounts mode
    if (!Array.isArray(args.ids) || !Array.isArray(args.amounts)) {
      throw new MantleMcpError(
        "INVALID_INPUT",
        "Merchant Moe removeLiquidity requires either 'percentage' or both 'ids' and 'amounts' arrays.",
        "Option A (recommended): provide percentage=100 to remove all liquidity. " +
          "Option B: provide ids (bin IDs) and amounts (LP token balances from balance_raw in mantle_getLBPositions output — NOT user_amount_x_raw or user_amount_y_raw).",
        { provider }
      );
    }

    if (args.ids.length !== args.amounts.length) {
      throw new MantleMcpError(
        "INVALID_INPUT",
        `ids array length (${args.ids.length}) does not match amounts array length (${args.amounts.length}).`,
        "Provide one amount per bin ID. Each amount must be the LP token balance (balance_raw) for that bin.",
        { ids_len: args.ids.length, amounts_len: args.amounts.length }
      );
    }

    ids = (args.ids as (number | string)[]).map((v, i) => {
      if (typeof v === "number" && !Number.isInteger(v)) {
        throw new MantleMcpError(
          "INVALID_INPUT",
          `ids[${i}] must be an integer, got ${v}.`,
          "Bin IDs must be whole numbers.",
          { index: i, value: v }
        );
      }
      return BigInt(v);
    });
    // Parse amounts carefully: accept both strings and numbers, always via BigInt
    // to avoid JS number precision loss for large LP balances (>2^53).
    amounts = (args.amounts as (string | number)[]).map((v, i) => {
      if (typeof v === "number" && !Number.isInteger(v)) {
        throw new MantleMcpError(
          "INVALID_INPUT",
          `amounts[${i}] must be an integer, got ${v}.`,
          "Use balance_raw (integer) values from mantle_getLBPositions.",
          { index: i, value: v }
        );
      }
      return BigInt(v);
    });
  }

  // ── Step 3: Compute slippage-protected minimums ─────────────────────
  const slippageBps =
    typeof args.slippage_bps === "number" ? args.slippage_bps : 50; // default 0.5%

  // Read bin reserves and total supply for each bin to estimate expected outputs.
  // Pro-rata share: expectedX += reserveX * amountToRemove / totalSupply (per bin).
  let amountXMin = 0n;
  let amountYMin = 0n;
  try {
    const reserveCalls = ids.flatMap((binId) => [
      { address: pairAddr, abi: LB_PAIR_ABI, functionName: "getBin" as const, args: [Number(binId)] },
      { address: pairAddr, abi: LB_PAIR_ABI, functionName: "totalSupply" as const, args: [binId] }
    ]);
    const reserveResults = await client.multicall({ contracts: reserveCalls });

    let expectedX = 0n;
    let expectedY = 0n;
    for (let i = 0; i < ids.length; i++) {
      const binRes = reserveResults[i * 2];
      const supplyRes = reserveResults[i * 2 + 1];
      if (binRes.status !== "success" || supplyRes.status !== "success") continue;
      const [reserveX, reserveY] = binRes.result as [bigint, bigint];
      const totalSupply = supplyRes.result as bigint;
      if (totalSupply === 0n) continue;
      expectedX += (reserveX * amounts[i]) / totalSupply;
      expectedY += (reserveY * amounts[i]) / totalSupply;
    }

    // Apply slippage tolerance
    amountXMin = (expectedX * BigInt(10000 - slippageBps)) / 10000n;
    amountYMin = (expectedY * BigInt(10000 - slippageBps)) / 10000n;
    warnings.push(
      `Slippage protection: amountXMin=${amountXMin.toString()}, amountYMin=${amountYMin.toString()} ` +
      `(${slippageBps}bps tolerance on estimated reserves).`
    );
  } catch {
    // If reserve reads fail, fall back to zero minimums with a warning
    warnings.push(
      "Could not read bin reserves for slippage protection — amountXMin and amountYMin are 0. " +
      "Consider using a short deadline to limit MEV exposure."
    );
  }

  // ── Step 4: Build calldata ──────────────────────────────────────────

  const data = encodeFunctionData({
    abi: LB_ROUTER_ABI,
    functionName: "removeLiquidity",
    args: [
      tokenX.address as `0x${string}`,
      tokenY.address as `0x${string}`,
      binStep,
      amountXMin,
      amountYMin,
      ids,
      amounts,
      recipient as `0x${string}`,
      deadline
    ]
  });

  // Best-effort pre-flight: verify the router is approved to burn the user's
  // LB shares. Without this, the tx will revert with LBToken__SpenderNotApproved.
  // We surface it as a prominent warning (or skip-hint) rather than hard-failing,
  // so off-chain flows that set approval atomically can still build the tx.
  try {
    if (
      pairAddr &&
      pairAddr !== "0x0000000000000000000000000000000000000000"
    ) {
      const isApproved = (await client.readContract({
        address: pairAddr as `0x${string}`,
        abi: LB_PAIR_ABI,
        functionName: "isApprovedForAll",
        args: [
          recipient as `0x${string}`,
          routerAddress as `0x${string}`
        ]
      })) as boolean;
      if (!isApproved) {
        warnings.unshift(
          `LB Router is NOT currently approved to burn your shares on pair ${pairAddr}. ` +
          `The removeLiquidity tx WILL revert until you broadcast a \`mantle_buildSetLBApprovalForAll\` ` +
          `(CLI: \`lp approve-lb --pair ${pairAddr} --operator ${routerAddress} --owner ${recipient}\`). ` +
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
    human_summary: `Remove liquidity on Merchant Moe LB: ${tokenX.symbol}/${tokenY.symbol} (${ids.length} bins, pair: ${pairAddr.slice(0, 10)}...)`,
    unsigned_tx: {
      to: routerAddress,
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings,
    pool_params: {
      provider: "merchant_moe",
      bin_step: binStep,
      router_address: routerAddress,
      pool_address: pairAddr
    },
    built_at_utc: d.now()
  };
}

const UINT128_MAX = BigInt("340282366920938463463374607431768211455");

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
        amount0Max: UINT128_MAX,
        amount1Max: UINT128_MAX
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

  // Declare warnings early so the balance-check catch block can push to it.
  const warnings: string[] = [
    `Ensure ${reserve.symbol} is approved for the Aave Pool (${poolAddress}) before supplying.`
  ];

  // ── Balance pre-check (blocking) ─────────────────────────────────────────
  try {
    const client = d.getClient(network);
    await checkErc20Balance(client, asset, amountRaw, onBehalfOf);
  } catch (err) {
    if (err instanceof MantleMcpError && err.code === "INSUFFICIENT_BALANCE") throw err;
    warnings.push(`Could not verify ${reserve.symbol} balance (RPC error). Proceeding without balance check.`);
  }

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

  // Declare warnings early so the balance-check catch block can push to it.
  const repayWarnings: string[] = [
    `Ensure ${reserve.symbol} is approved for the Aave Pool (${poolAddress}) before repaying.`
  ];

  // ── Balance pre-check (blocking) — skipped when amount='max' (MAX_UINT256) ─
  try {
    const client = d.getClient(network);
    await checkErc20Balance(client, asset, amountRaw, onBehalfOf);
  } catch (err) {
    if (err instanceof MantleMcpError && err.code === "INSUFFICIENT_BALANCE") throw err;
    repayWarnings.push(`Could not verify ${reserve.symbol} balance (RPC error). Proceeding without balance check.`);
  }

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
    warnings: repayWarnings,
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

  // ── aToken balance pre-check (blocking) — skipped when amount='max' ──────
  // In Aave V3 withdraw(asset, amount, to), the CALLER's (msg.sender's) aTokens
  // are burned, not `to`'s. `to` is only the recipient of the underlying tokens.
  // We check the signer's aToken balance via the optional `owner` param.
  // When `owner` is omitted the check is skipped (no false positives on `to`).
  const withdrawOwner = typeof args.owner === "string" && isAddress(args.owner, { strict: false })
    ? getAddress(args.owner)
    : null;
  if (withdrawOwner) {
    try {
      const client = d.getClient(network);
      await checkErc20Balance(
        client,
        { address: reserve.aToken, symbol: `a${reserve.symbol}`, decimals: reserve.decimals },
        amountRaw,
        withdrawOwner
      );
    } catch (err) {
      if (err instanceof MantleMcpError && err.code === "INSUFFICIENT_BALANCE") throw err;
    }
  }

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

  // Validate position existence on-chain
  const client = d.getClient(network);
  const positionResult = await client.readContract({
    address: positionManager as `0x${string}`,
    abi: V3_POSITION_MANAGER_ABI,
    functionName: "positions",
    args: [tokenId]
  });

  const positionData = positionResult as readonly [
    bigint, string, string, string, number, number, number,
    bigint, bigint, bigint, bigint, bigint
  ];
  const liquidity = positionData[7];
  const tokensOwed0 = positionData[10];
  const tokensOwed1 = positionData[11];

  if (liquidity === 0n && tokensOwed0 === 0n && tokensOwed1 === 0n) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `Position #${tokenId} has no liquidity and no accrued fees to collect.`,
      "Verify the token ID is correct and that the position has earned fees.",
      { token_id: tokenIdStr, provider }
    );
  }

  const pokeNote = liquidity > 0n
    ? " Actual collected amount may be higher after the poke settles pending fees."
    : " Position is closed (zero liquidity); tokensOwed reflects all available fees.";
  const warnings: string[] = [
    `Pre-poke tokensOwed: token0=${tokensOwed0.toString()}, token1=${tokensOwed1.toString()}.${pokeNote}`
  ];

  const deadline = d.deadline();

  // Collect accrued fees. When the position still has liquidity, prepend a
  // "poke" (decreaseLiquidity with liquidity=0) to settle any pending fees
  // into tokensOwed0/tokensOwed1 before collecting. Skip the poke when
  // liquidity === 0n because the V3 NonfungiblePositionManager reverts
  // decreaseLiquidity with `require(params.liquidity > 0)` on zero-liquidity
  // positions (fees are already settled into tokensOwed when liquidity was
  // fully removed).
  const collectData = encodeFunctionData({
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

  const multicallOps: `0x${string}`[] = [];
  if (liquidity > 0n) {
    const pokeData = encodeFunctionData({
      abi: V3_POSITION_MANAGER_ABI,
      functionName: "decreaseLiquidity",
      args: [
        {
          tokenId,
          liquidity: 0n,
          amount0Min: 0n,
          amount1Min: 0n,
          deadline
        }
      ]
    });
    multicallOps.push(pokeData);
  }
  multicallOps.push(collectData);

  const data = encodeFunctionData({
    abi: V3_POSITION_MANAGER_ABI,
    functionName: "multicall",
    args: [multicallOps]
  });

  const providerLabel = provider === "agni" ? "Agni" : "Fluxion";

  return {
    intent: "collect_fees",
    human_summary: `Poke + collect accrued fees from ${providerLabel} V3 position #${tokenId} to ${recipient}`,
    unsigned_tx: {
      to: positionManager,
      data,
      value: "0x0",
      chainId: chainId(network)
    },
    warnings,
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
        },
        nonce: {
          type: "number",
          description: "Optional nonce override. Query mantle_getNonce first to get the correct value. Only use when the signer has nonce issues."
        }
      },
      required: ["token", "spender", "amount"]
    },
    handler: wrapBuildHandler(buildApprove)
  },

  mantle_buildWrapMnt: {
    name: "mantle_buildWrapMnt",
    description:
      "Build an unsigned transaction to wrap MNT into WMNT. Returns calldata with value field set to the wrap amount.\n\nIf sender is provided, performs a blocking MNT balance check — throws INSUFFICIENT_BALANCE if the wallet cannot cover the amount.\n\nExamples:\n- Wrap 10 MNT: amount='10', sender='0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'\n- Wrap 0.5 MNT: amount='0.5'",
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
        },
        nonce: {
          type: "number",
          description: "Optional nonce override. Query mantle_getNonce first to get the correct value. Only use when the signer has nonce issues."
        }
      },
      required: ["amount"]
    },
    handler: wrapBuildHandler(buildWrapMnt)
  },

  mantle_buildUnwrapMnt: {
    name: "mantle_buildUnwrapMnt",
    description:
      "Build an unsigned transaction to unwrap WMNT back to MNT.\n\nIf sender is provided, performs a blocking WMNT balance check — throws INSUFFICIENT_BALANCE if the wallet cannot cover the amount.\n\nExamples:\n- Unwrap 10 WMNT: amount='10', sender='0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'\n- Unwrap 0.5 WMNT: amount='0.5'",
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
        },
        nonce: {
          type: "number",
          description: "Optional nonce override. Query mantle_getNonce first to get the correct value. Only use when the signer has nonce issues."
        }
      },
      required: ["amount"]
    },
    handler: wrapBuildHandler(buildUnwrapMnt)
  },

  mantle_buildSwap: {
    name: "mantle_buildSwap",
    description:
      "Build an unsigned swap transaction on a whitelisted DEX. Pool parameters (bin_step, fee_tier) are auto-discovered on-chain for the best liquidity pool.\n\nWORKFLOW:\n1. Call mantle_getSwapQuote → returns router_address, provider, and resolved_pool_params\n2. Call mantle_buildApprove: token=token_in, spender=router_address from step 1, amount=amount_in, owner=wallet_address. IMPORTANT: spender is the ROUTER address (e.g. 0x319B69888b0d11cEC22caA5034e25FfFBDc88421 for Agni), NOT the token address.\n3. Sign and broadcast the approve unsigned_tx. Wait for confirmation.\n4. Call mantle_buildSwap with: provider from quote, amount_out_min from quote's minimum_out_raw, owner=wallet_address (triggers blocking allowance check), and quote_fee_tier/quote_provider for cross-validation\n5. Sign and broadcast the swap unsigned_tx\n\nIf owner is passed and allowance is insufficient, buildSwap will REJECT with INSUFFICIENT_ALLOWANCE (not just warn). The error includes the correct router_address to approve.\n\nThe response includes pool_params.router_address — this is the spender for approve.\n\nExamples:\n- Swap 100 USDC for USDT0 on Merchant Moe: provider='merchant_moe', token_in='USDC', token_out='USDT0', amount_in='100', recipient='0x...', owner='0x...'\n- Swap 10 WMNT for USDC on Agni: provider='agni', token_in='WMNT', token_out='USDC', amount_in='10', recipient='0x...', owner='0x...'",
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
            "V3 fee tier (100=0.01%, 500=0.05%, 2500=0.25%, 3000=0.3%, 10000=1%). Auto-resolved from on-chain liquidity for agni/fluxion when omitted."
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
          description: "STRONGLY RECOMMENDED: Wallet address that owns the input tokens (the signer). Triggers a blocking allowance check — if allowance is insufficient, the call rejects with INSUFFICIENT_ALLOWANCE (includes the correct router_address to approve) instead of returning a swap tx that would revert on-chain."
        },
        nonce: {
          type: "number",
          description: "Optional nonce override. Query mantle_getNonce first to get the correct value. Only use when the signer has nonce issues."
        }
      },
      required: ["provider", "token_in", "token_out", "amount_in", "recipient"]
    },
    handler: wrapBuildHandler(buildSwap)
  },

  mantle_buildAddLiquidity: {
    name: "mantle_buildAddLiquidity",
    description:
      "Build an unsigned add-liquidity transaction. For V3 DEXes (agni/fluxion) mints an NFT position. For Merchant Moe LB adds to bin-based pools.\n\n" +
      "Amount modes:\n- Token amounts: provide amount_a and amount_b directly\n- USD amount: provide amount_usd to auto-split between tokens (fetches live prices; V3 uses pool-state-aware ratio)\n\n" +
      "Range presets (RECOMMENDED for simplicity):\n" +
      "- 'aggressive' — ±5% around current price (highest capital efficiency, needs frequent rebalancing)\n" +
      "- 'moderate' — ±10% around current price (balanced efficiency vs. rebalancing)\n" +
      "- 'conservative' — ±20% around current price (wider range, less rebalancing needed)\n" +
      "For V3: auto-computes tick_lower/tick_upper from current pool tick. For Merchant Moe LB: auto-computes bin spread.\n" +
      "Explicit tick_lower/tick_upper override range_preset.\n\n" +
      "IMPORTANT: Pass 'owner' to enable a blocking allowance check. If either token's allowance is insufficient, " +
      "the call rejects with INSUFFICIENT_ALLOWANCE and includes the correct spender address and a ready-to-use " +
      "mantle_buildApprove invocation. The response always includes pool_params.router_address — the spender to approve.\n\n" +
      "WORKFLOW: Before calling this tool, use mantle_findPools to discover the best pool (recommended_pool) for the token pair.\n\n" +
      "Examples:\n" +
      "- With range preset: provider='agni', token_a='WMNT', token_b='USDC', amount_usd=1000, range_preset='moderate', recipient='0x...', owner='0x...'\n" +
      "- Token mode: provider='agni', token_a='WMNT', token_b='USDC', amount_a='10', amount_b='8', recipient='0x...', owner='0x...'\n" +
      "- USD mode: provider='agni', token_a='WMNT', token_b='USDC', amount_usd=1000, recipient='0x...', owner='0x...'",
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
          description: "V3 fee tier for agni/fluxion: 100=0.01% (stablecoins, e.g. USDe/USDT), 500=0.05%, 2500=0.25% (e.g. WMNT/USDe, cmETH/USDe on Agni), 3000=0.3%, 10000=1%. Default: 3000 — but you MUST pass the actual pool's fee tier (use mantle_findPools to look it up); defaulting to 3000 will fail for pools that don't exist at that tier."
        },
        tick_lower: {
          type: "number",
          description: "Lower tick bound. For agni/fluxion. Overrides range_preset. Default: full range."
        },
        tick_upper: {
          type: "number",
          description: "Upper tick bound. For agni/fluxion. Overrides range_preset. Default: full range."
        },
        range_preset: {
          type: "string",
          description:
            "RECOMMENDED: Price range preset for LP position. " +
            "'aggressive' (±5%), 'moderate' (±10%), 'conservative' (±20%). " +
            "Auto-computes tick bounds (V3) or bin spread (Merchant Moe LB) from current pool price. " +
            "Overridden by explicit tick_lower/tick_upper. " +
            "If omitted and no ticks provided, defaults to full range (V3) or ±3 bins (LB)."
        },
        bin_step: {
          type: "number",
          description: "LB bin step (default: 25). For merchant_moe."
        },
        active_id: {
          type: "number",
          description: "Active bin ID override. For merchant_moe. If omitted, auto-resolved from on-chain pair state (recommended)."
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
        },
        owner: {
          type: "string",
          description:
            "STRONGLY RECOMMENDED: Wallet address that will sign the transaction. " +
            "Triggers a blocking allowance check for both tokens — if either allowance is insufficient, " +
            "the call rejects with INSUFFICIENT_ALLOWANCE (includes the correct spender address to approve) " +
            "instead of returning a tx that would revert on-chain with STF."
        },
        nonce: {
          type: "number",
          description: "Optional nonce override. Query mantle_getNonce first to get the correct value. Only use when the signer has nonce issues."
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
      "Build an unsigned remove-liquidity transaction. For V3 DEXes uses decreaseLiquidity+collect via multicall. For Merchant Moe LB removes from specified bins.\n\nV3 amount modes:\n- Exact liquidity: provide 'liquidity' as a raw amount\n- Percentage: provide 'percentage' (1-100) to remove a portion of the position (reads current liquidity on-chain)\n\nMerchant Moe amount modes:\n- Percentage (RECOMMENDED): provide 'percentage' (1-100) to auto-read LP balances on-chain and remove proportionally. Optionally provide 'ids' to target specific bins; if omitted, scans ±25 bins around active price.\n- Explicit: provide 'ids' (bin IDs) and 'amounts' (LP token balances to burn). CRITICAL: 'amounts' must be 'balance_raw' values from mantle_getLBPositions output — NOT 'user_amount_x_raw' or 'user_amount_y_raw'. LP token balances are typically 1e18-scale numbers.\n\nExamples:\n- Remove 50% of V3 position: provider='agni', token_id='12345', percentage=50, recipient='0x...'\n- Remove all V3 position: provider='agni', token_id='12345', percentage=100, recipient='0x...'\n- Remove exact liquidity: provider='agni', token_id='12345', liquidity='1000000', recipient='0x...'\n- Remove all Merchant Moe LP (recommended): provider='merchant_moe', token_a='WMNT', token_b='USDC', bin_step=25, percentage=100, recipient='0x...'\n- Remove 50% of Merchant Moe LP: provider='merchant_moe', token_a='WMNT', token_b='USDC', bin_step=25, percentage=50, recipient='0x...'\n- Remove specific LB bins: provider='merchant_moe', token_a='WMNT', token_b='USDC', bin_step=25, ids=[8388608], amounts=['500000000000000000'], recipient='0x...'",
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
            "Percentage of position liquidity to remove (1-100). Works for BOTH V3 (agni/fluxion) and Merchant Moe. " +
            "Reads current LP balances on-chain and calculates the amount. " +
            "RECOMMENDED for Merchant Moe — avoids the need to manually query balance_raw values. " +
            "Example: 50 removes half, 100 removes all."
        },
        token_a: {
          type: "string",
          description: "First token symbol or address. For merchant_moe. Token order does not matter — canonical order is resolved on-chain."
        },
        token_b: {
          type: "string",
          description: "Second token symbol or address. For merchant_moe. Token order does not matter — canonical order is resolved on-chain."
        },
        bin_step: {
          type: "number",
          description: "LB bin step. For merchant_moe."
        },
        ids: {
          type: "array",
          description: "Bin IDs to remove from. For merchant_moe. Optional when using percentage mode (auto-scans ±25 bins if omitted)."
        },
        amounts: {
          type: "array",
          description: "LP token balances to burn per bin. For merchant_moe. MUST be 'balance_raw' values from mantle_getLBPositions — these are ERC-1155 LP share token counts (typically 1e18-scale). Do NOT pass 'user_amount_x_raw' or 'user_amount_y_raw' (those are underlying token estimates, not LP shares). Prefer using 'percentage' mode instead."
        },
        owner: {
          type: "string",
          description: "Wallet address that holds the LP tokens (the signer). For merchant_moe percentage mode: used to query on-chain LP balances. If omitted, defaults to recipient. Provide this when recipient differs from the signer."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        },
        nonce: {
          type: "number",
          description: "Optional nonce override. Query mantle_getNonce first to get the correct value. Only use when the signer has nonce issues."
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
      "Build an unsigned Aave V3 supply (deposit) transaction. This calls Pool.supply() which pulls tokens " +
      "via transferFrom AND mints aTokens — the aToken balance is the ONLY on-chain record redeemable via withdraw. " +
      "NEVER model 'supply' as a plain ERC-20 transfer() to the Pool address (0x458F293454fE0d67EC0655f3672301301DD51422) — " +
      "that bypasses Pool accounting, mints NO aToken, and locks funds PERMANENTLY with no recovery path. " +
      "Always use THIS tool for Aave supply operations. Remember to approve the asset for the Pool contract first.\n\n" +
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
        },
        nonce: {
          type: "number",
          description: "Optional nonce override. Query mantle_getNonce first to get the correct value. Only use when the signer has nonce issues."
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
        },
        nonce: {
          type: "number",
          description: "Optional nonce override. Query mantle_getNonce first to get the correct value. Only use when the signer has nonce issues."
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
        },
        nonce: {
          type: "number",
          description: "Optional nonce override. Query mantle_getNonce first to get the correct value. Only use when the signer has nonce issues."
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
        },
        nonce: {
          type: "number",
          description: "Optional nonce override. Query mantle_getNonce first to get the correct value. Only use when the signer has nonce issues."
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
        },
        nonce: {
          type: "number",
          description: "Optional nonce override. Query mantle_getNonce first to get the correct value. Only use when the signer has nonce issues."
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
      "Build an unsigned transaction to collect accrued fees from a V3 LP position (Agni or Fluxion). Collects the maximum available fees for both tokens.\n\nWORKFLOW:\n1. Obtain the V3 NFT position token_id — call mantle_getV3Positions to enumerate, look it up on a block explorer (Mantlescan) / https://agni.finance, or read it from the unsigned_tx response of a prior mantle_buildAddLiquidity call.\n2. Call mantle_buildCollectFees with the token_id\n3. Sign and broadcast the unsigned_tx\n\nExamples:\n- Collect Agni fees: provider='agni', token_id='12345', recipient='0x...'\n- Collect Fluxion fees: provider='fluxion', token_id='67890', recipient='0x...'\n\nNOTE: Merchant Moe LB fees are embedded in bin reserves and collected automatically when removing liquidity via mantle_buildRemoveLiquidity. This tool only supports V3 positions (Agni/Fluxion).",
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
        },
        nonce: {
          type: "number",
          description: "Optional nonce override. Query mantle_getNonce first to get the correct value. Only use when the signer has nonce issues."
        }
      },
      required: ["provider", "token_id", "recipient"]
    },
    handler: wrapBuildHandler(buildCollectFees)
  }
};
