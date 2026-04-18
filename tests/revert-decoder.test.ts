/**
 * Tests for revert-decoder.ts and its integration with GAS_ESTIMATION_FAILED.
 *
 * The point of this module is to pull raw revert bytes out of whatever viem
 * error layer carries them and decode the two standard wrappers
 * (Error(string), Panic(uint256)) so agents stop fabricating selector tables
 * when gas estimation fails.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { encodeErrorResult, toHex } from "viem";
import {
  decodeRevertFromError,
  revertInfoToDetails
} from "@mantleio/mantle-core/lib/revert-decoder.js";
import { MantleMcpError } from "@mantleio/mantle-core/errors.js";

// ---------------------------------------------------------------------------
// Helpers — build revert payloads the way viem would produce them.
// ---------------------------------------------------------------------------

const ERROR_STRING_ABI = [
  { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }
] as const;

const PANIC_ABI = [
  { type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] }
] as const;

function makeErrorStringRevert(message: string): `0x${string}` {
  return encodeErrorResult({
    abi: ERROR_STRING_ABI,
    errorName: "Error",
    args: [message]
  });
}

function makePanicRevert(code: bigint): `0x${string}` {
  return encodeErrorResult({
    abi: PANIC_ABI,
    errorName: "Panic",
    args: [code]
  });
}

// Mimic how viem wraps a revert: outer EstimateGasExecutionError whose
// `.cause` chain eventually bottoms out at a RawContractError carrying the
// hex data. We don't need the real classes to exercise the walker — plain
// objects with `.cause` / `.data` are enough.
function makeViemLikeError(revertData: `0x${string}`): Error {
  const raw: any = new Error("execution reverted");
  raw.name = "RawContractError";
  raw.data = revertData;

  const rpc: any = new Error("RPC request failed");
  rpc.name = "RpcRequestError";
  rpc.cause = raw;

  const outer: any = new Error("Gas estimation failed");
  outer.name = "EstimateGasExecutionError";
  outer.cause = rpc;
  return outer;
}

// ---------------------------------------------------------------------------
// decodeRevertFromError — unit tests on the walker + decoder.
// ---------------------------------------------------------------------------

describe("decodeRevertFromError", () => {
  it("decodes Error(string) from a deeply nested cause chain", () => {
    const err = makeViemLikeError(makeErrorStringRevert("INVALID_AMOUNT"));
    const info = decodeRevertFromError(err);

    expect(info).not.toBeNull();
    expect(info!.name).toBe("Error");
    expect(info!.selector).toBe("0x08c379a0");
    // The raw payload must always be preserved verbatim so callers can look
    // it up externally when we can't decode.
    expect(info!.raw.startsWith("0x08c379a0")).toBe(true);
    expect(info!.message).toContain("INVALID_AMOUNT");
    expect(info!.args).toEqual(["INVALID_AMOUNT"]);
  });

  it("decodes Panic(uint256) and names the code", () => {
    const err = makeViemLikeError(makePanicRevert(0x11n)); // arithmetic
    const info = decodeRevertFromError(err);

    expect(info).not.toBeNull();
    expect(info!.name).toBe("Panic");
    expect(info!.selector).toBe("0x4e487b71");
    expect(info!.message).toContain("arithmetic overflow");
    // Args are normalised to strings by revertInfoToDetails, but raw is bigint here.
    expect(info!.args?.[0]).toBe(0x11n);
  });

  it("returns selector-only info for unknown custom errors", () => {
    // 0x17c5a78e is the selector from the production incident that kicked
    // off this whole exercise. It isn't in our ABI table, so the decoder
    // must surface it as raw + selector without inventing a name.
    const raw = "0x17c5a78e" as const;
    const err = makeViemLikeError(raw);
    const info = decodeRevertFromError(err);

    expect(info).not.toBeNull();
    expect(info!.raw).toBe(raw);
    expect(info!.selector).toBe("0x17c5a78e");
    expect(info!.name).toBeNull();
    expect(info!.message).toContain("unknown custom error");
    expect(info!.message).toContain("0x17c5a78e");
  });

  it("surfaces empty revert data as a reason-less revert", () => {
    const err = makeViemLikeError("0x");
    const info = decodeRevertFromError(err);

    expect(info).not.toBeNull();
    expect(info!.raw).toBe("0x");
    expect(info!.selector).toBeNull();
    expect(info!.message).toBe("revert without reason data");
  });

  it("returns null when no revert data is anywhere on the cause chain", () => {
    // Pure RPC / network failure — nothing to decode.
    const err = new Error("fetch failed: ECONNREFUSED");
    expect(decodeRevertFromError(err)).toBeNull();
  });

  it("prefers .data over .raw when both are present, and handles nested {data: {data}}", () => {
    const revert = makeErrorStringRevert("nested ok");
    const err: any = new Error("outer");
    // viem's RawContractError occasionally carries data as { data: Hex } —
    // the walker must unwrap both shapes.
    err.data = { data: revert };

    const info = decodeRevertFromError(err);
    expect(info?.name).toBe("Error");
    expect(info?.message).toContain("nested ok");
  });
});

describe("revertInfoToDetails", () => {
  it("emits a compact object with raw + selector + message, stringifying bigints", () => {
    const info = decodeRevertFromError(makeViemLikeError(makePanicRevert(0x11n)));
    const details = revertInfoToDetails(info);

    expect(details.revert_raw).toBeDefined();
    expect(details.revert_selector).toBe("0x4e487b71");
    expect(details.revert_name).toBe("Panic");
    // bigint must be serialisable — we stringify for JSON safety.
    expect(details.revert_args).toEqual(["17"]);
  });

  it("returns an empty object for null input (safe to spread into details)", () => {
    expect(revertInfoToDetails(null)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Integration — GAS_ESTIMATION_FAILED from defi-write must carry revert info.
// ---------------------------------------------------------------------------

const mockEstimateGas = vi.fn();
const mockGetBlock = vi.fn();
const mockEstimateMaxPriorityFeePerGas = vi.fn();
const mockReadContract = vi.fn();
const mockGetTransactionCount = vi.fn();

const mockClient = {
  estimateGas: mockEstimateGas,
  getBlock: mockGetBlock,
  estimateMaxPriorityFeePerGas: mockEstimateMaxPriorityFeePerGas,
  readContract: mockReadContract,
  getTransactionCount: mockGetTransactionCount
};

vi.mock("@mantleio/mantle-core/lib/clients.js", () => ({
  getPublicClient: vi.fn(() => mockClient),
  getRpcUrl: vi.fn(() => "https://mock.rpc"),
  getRpcUrls: vi.fn(() => ["https://mock.rpc"])
}));

const { defiWriteTools } = await import("@mantleio/mantle-core/tools/defi-write.js");

const OWNER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const USDC = { address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9", symbol: "USDC", decimals: 6 };
const WMNT = { address: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8", symbol: "WMNT", decimals: 18 };

const swapArgs = {
  provider: "agni",
  token_in: "WMNT",
  token_out: "USDC",
  amount_in: "1",
  amount_out_min: "1000000",
  recipient: RECIPIENT,
  owner: OWNER,
  network: "mainnet",
  fee_tier: 500
};

const swapDeps = {
  resolveTokenInput: async (input: string) => {
    if (input.toUpperCase() === "USDC") return USDC;
    if (input.toUpperCase() === "WMNT") return WMNT;
    throw new Error(`unknown token ${input}`);
  },
  getClient: () => ({
    readContract: async () => BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
    multicall: async () => []
  }) as any,
  now: () => "2026-04-17T00:00:00.000Z",
  deadline: () => 1_800_000_000n
};

describe("GAS_ESTIMATION_FAILED carries revert info end-to-end", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBlock.mockResolvedValue({ baseFeePerGas: 50_000_000n } as any);
    mockEstimateMaxPriorityFeePerGas.mockResolvedValue(2_000_000n);
    mockReadContract.mockResolvedValue(
      BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
    );
    mockGetTransactionCount.mockResolvedValue(1);
  });

  it("attaches revert_selector and decoded Error(string) to the MantleMcpError", async () => {
    mockEstimateGas.mockRejectedValue(makeViemLikeError(makeErrorStringRevert("23")));
    // Aave uses numeric string codes (e.g. "23" = SAFEERC20_LOWLEVEL_CALL).
    // Our CLI consumers get the raw code back and can map it themselves.

    try {
      await defiWriteTools["mantle_buildSwap"].handler(swapArgs, swapDeps);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MantleMcpError);
      const e = err as MantleMcpError;
      expect(e.code).toBe("GAS_ESTIMATION_FAILED");
      // The enriched message surfaces the decoded reason so agents don't
      // have to dig into details.
      expect(e.message).toContain("[revert: Error(string): 23]");
      expect(e.details.revert_selector).toBe("0x08c379a0");
      expect(e.details.revert_name).toBe("Error");
      expect(e.details.revert_args).toEqual(["23"]);
      // Raw bytes must always be present for external lookup.
      expect(e.details.revert_raw).toMatch(/^0x08c379a0/);
    }
  });

  it("attaches unknown custom-error selectors without inventing a name", async () => {
    // This is the exact shape of the incident: a 4-byte selector with no
    // params. The decoder must NOT pretend to know what it is.
    mockEstimateGas.mockRejectedValue(makeViemLikeError("0x17c5a78e"));

    try {
      await defiWriteTools["mantle_buildSwap"].handler(swapArgs, swapDeps);
      throw new Error("expected throw");
    } catch (err) {
      const e = err as MantleMcpError;
      expect(e.code).toBe("GAS_ESTIMATION_FAILED");
      expect(e.details.revert_selector).toBe("0x17c5a78e");
      expect(e.details.revert_name).toBeUndefined(); // unknown → no name
      expect(e.details.revert_raw).toBe("0x17c5a78e");
      expect(e.message).toContain("0x17c5a78e");
    }
  });

  it("still throws GAS_ESTIMATION_FAILED when the error has no revert data (pure RPC failure)", async () => {
    // Pre-change behaviour: bare throw with no hex data on the chain.
    // Post-change behaviour: still a clean GAS_ESTIMATION_FAILED; no
    // revert_* fields because there's nothing to surface.
    mockEstimateGas.mockRejectedValue(new Error("fetch failed: ECONNREFUSED"));

    try {
      await defiWriteTools["mantle_buildSwap"].handler(swapArgs, swapDeps);
      throw new Error("expected throw");
    } catch (err) {
      const e = err as MantleMcpError;
      expect(e.code).toBe("GAS_ESTIMATION_FAILED");
      expect(e.details.revert_selector).toBeUndefined();
      expect(e.details.revert_raw).toBeUndefined();
    }
  });
});
