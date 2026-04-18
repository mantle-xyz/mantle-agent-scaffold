/**
 * Revert-data extraction and decoding.
 *
 * When viem's estimateGas / call fails because of an on-chain revert, the raw
 * revert bytes are available somewhere in the error cause chain. We need
 * those bytes so that callers — especially agents — can diagnose the revert
 * without resorting to raw RPC curl or fabricated selector tables.
 *
 * This module does three things:
 *
 *   1. Walks a thrown viem error to pull the raw `0x…` revert data out of
 *      whatever layer carries it (RawContractError, RpcRequestError, or an
 *      anonymous `{ data }` field on the cause).
 *   2. Decodes the two standard Solidity error wrappers that the compiler
 *      emits unconditionally: `Error(string)` (`require(…, "msg")` reverts)
 *      and `Panic(uint256)` (arithmetic/overflow/assert reverts).
 *   3. Decodes a curated table of Aave V3 Pool custom errors by 4-byte
 *      selector. Not exhaustive — Aave V3 primarily uses `require(cond,
 *      Errors.CODE)` with numeric string codes, which land in the
 *      `Error(string)` path above.
 *
 * Anything this module cannot name is still surfaced as a raw selector and
 * raw bytes so the caller can look it up externally.
 */

import { decodeErrorResult, type Hex } from "viem";

/**
 * Standardised revert description attached to RPC-layer failures.
 *
 * - `selector` is always set when `raw` is non-empty. It's the 4-byte custom
 *   error id (e.g. `0x08c379a0` for `Error(string)`).
 * - `name` is set when we successfully decode the revert against a known ABI
 *   entry (`Error`, `Panic`, or one of the Aave V3 selectors below).
 * - `args` holds the decoded parameters (strings/numbers/addresses) when
 *   `name` is set.
 * - `message` is a short, single-line human summary; when we couldn't
 *   decode, it's literally `"unknown custom error <selector>"` so the caller
 *   knows to look the selector up.
 */
export interface RevertInfo {
  raw: Hex;
  selector: Hex | null;
  name: string | null;
  args: readonly unknown[] | null;
  message: string;
}

// ---------------------------------------------------------------------------
// Minimal ABI covering the two standard Solidity error wrappers.
// ---------------------------------------------------------------------------

const STANDARD_ERROR_ABI = [
  {
    type: "error",
    name: "Error",
    inputs: [{ name: "message", type: "string" }]
  },
  {
    type: "error",
    name: "Panic",
    inputs: [{ name: "code", type: "uint256" }]
  }
] as const;

// ---------------------------------------------------------------------------
// Aave V3 custom-error ABI.
//
// Sourced from aave-v3-core / aave-v3-origin. Most Pool reverts use the
// string-code path (Errors.sol), but these specific selectors show up from
// newer Pool versions and adjacent contracts. We keep the list short and
// commented so additions are deliberate.
// ---------------------------------------------------------------------------

const AAVE_V3_ERROR_ABI = [
  // Raised when a Pool action would leave the user below the liquidation
  // threshold. Most commonly hit when borrowing too much or withdrawing/
  // disabling collateral that the account depends on.
  {
    type: "error",
    name: "HealthFactorLowerThanLiquidationThreshold",
    inputs: []
  },
  // Raised when a user tries to borrow an asset that's disallowed for their
  // current eMode category.
  {
    type: "error",
    name: "InconsistentEModeCategory",
    inputs: []
  },
  // Raised when disabling collateral would leave HF below threshold.
  {
    type: "error",
    name: "CollateralCannotCoverNewBorrow",
    inputs: []
  }
] as const;

// ---------------------------------------------------------------------------
// Well-known Panic codes (Solidity 0.8+). Keeping this short — these are the
// ones users actually hit in DeFi flows.
// ---------------------------------------------------------------------------

const PANIC_CODES: Record<string, string> = {
  "0x00": "generic panic",
  "0x01": "assertion failed",
  "0x11": "arithmetic overflow or underflow",
  "0x12": "division or modulo by zero",
  "0x21": "invalid enum conversion",
  "0x22": "storage byte array encoding error",
  "0x31": "pop() on empty array",
  "0x32": "array index out of bounds",
  "0x41": "out of memory / too-large allocation",
  "0x51": "uninitialised function pointer call"
};

// ---------------------------------------------------------------------------
// Error-walking. viem nests RPC errors several layers deep; the raw data can
// live on any of them. We hunt for the first string that looks like a
// 0x-prefixed hex payload on the cause chain.
// ---------------------------------------------------------------------------

function isHexString(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

function extractHexData(err: unknown): Hex | null {
  // viem's RawContractError sometimes stores data as `{ data: "0x..." }`
  // instead of a direct string; handle both.
  const seen = new Set<unknown>();
  let cur: any = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);

    if (isHexString(cur.data) && cur.data.length >= 2) {
      return cur.data as Hex;
    }
    if (cur.data && typeof cur.data === "object" && isHexString(cur.data.data)) {
      return cur.data.data as Hex;
    }
    // Some viem error classes expose `raw` directly (ContractFunctionRevertedError).
    if (isHexString(cur.raw) && cur.raw.length >= 2) {
      return cur.raw as Hex;
    }
    cur = cur.cause ?? null;
  }
  return null;
}

/**
 * Try to extract and decode the revert payload from a thrown viem error.
 * Returns `null` when no hex revert data could be found — typically a
 * network-layer failure (RPC unreachable, timeout) rather than an on-chain
 * revert.
 */
export function decodeRevertFromError(err: unknown): RevertInfo | null {
  const raw = extractHexData(err);
  if (!raw || raw === "0x" || raw.length < 10) {
    // Nothing decodable. `0x` or sub-4-byte data usually means the RPC
    // reverted without a reason string (older chains or out-of-gas).
    if (raw === "0x" || (raw && raw.length < 10)) {
      return {
        raw,
        selector: null,
        name: null,
        args: null,
        message: "revert without reason data"
      };
    }
    return null;
  }

  const selector = raw.slice(0, 10) as Hex;

  // Try standard Error(string) and Panic(uint256) first — these cover 90%+
  // of Solidity reverts.
  try {
    const decoded = decodeErrorResult({
      abi: STANDARD_ERROR_ABI,
      data: raw
    });
    if (decoded.errorName === "Error") {
      const msg = String(decoded.args?.[0] ?? "");
      return {
        raw,
        selector,
        name: "Error",
        args: decoded.args as readonly unknown[],
        message: `Error(string): ${msg}`
      };
    }
    if (decoded.errorName === "Panic") {
      const code = decoded.args?.[0];
      const codeHex =
        typeof code === "bigint"
          ? "0x" + code.toString(16).padStart(2, "0")
          : null;
      const panicName = codeHex ? PANIC_CODES[codeHex] ?? "unknown panic" : "unknown panic";
      return {
        raw,
        selector,
        name: "Panic",
        args: decoded.args as readonly unknown[],
        message: `Panic(${codeHex ?? "?"}): ${panicName}`
      };
    }
  } catch {
    // Not a standard wrapper — fall through to Aave lookup.
  }

  // Try the Aave custom-error ABI.
  try {
    const decoded = decodeErrorResult({
      abi: AAVE_V3_ERROR_ABI,
      data: raw
    });
    return {
      raw,
      selector,
      name: decoded.errorName,
      args: (decoded.args ?? []) as readonly unknown[],
      message: `Aave V3: ${decoded.errorName}`
    };
  } catch {
    // Unknown custom error. Surface the selector so the caller can look it
    // up externally (4byte.directory, Aave source, etc).
  }

  return {
    raw,
    selector,
    name: null,
    args: null,
    message: `unknown custom error ${selector} (${
      raw.length > 10 ? `${Math.floor((raw.length - 10) / 2)} bytes of arg data` : "no args"
    })`
  };
}

/**
 * Shape the revert info for inclusion in an error `details` payload.
 * Omits nulls so the JSON stays compact and stable.
 */
export function revertInfoToDetails(info: RevertInfo | null): Record<string, unknown> {
  if (!info) return {};
  const out: Record<string, unknown> = {
    revert_raw: info.raw,
    revert_message: info.message
  };
  if (info.selector) out.revert_selector = info.selector;
  if (info.name) out.revert_name = info.name;
  if (info.args && info.args.length > 0) {
    // Normalise bigints for JSON serialisation.
    out.revert_args = info.args.map((a) =>
      typeof a === "bigint" ? a.toString() : a
    );
  }
  return out;
}
