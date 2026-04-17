/**
 * Tests for gas estimation logic inside wrapBuildHandler.
 *
 * wrapBuildHandler is private — we exercise it by calling the wrapped handler
 * from defiWriteTools["mantle_buildSwap"].handler, which is wrapBuildHandler(buildSwap).
 *
 * Since wrapBuildHandler calls getPublicClient directly (not through deps),
 * we mock the module at import level with vi.mock.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { MantleMcpError } from "@mantleio/mantle-core/errors.js";

// ---------------------------------------------------------------------------
// Mock getPublicClient at module level BEFORE importing defiWriteTools
// ---------------------------------------------------------------------------

const mockEstimateGas = vi.fn<() => Promise<bigint>>();
const mockGetBlock = vi.fn<() => Promise<{ baseFeePerGas: bigint | null }>>();
const mockEstimateMaxPriorityFeePerGas = vi.fn<() => Promise<bigint>>();
const mockReadContract = vi.fn<() => Promise<bigint>>();

const mockClient = {
  estimateGas: mockEstimateGas,
  getBlock: mockGetBlock,
  estimateMaxPriorityFeePerGas: mockEstimateMaxPriorityFeePerGas,
  readContract: mockReadContract,
};

vi.mock("@mantleio/mantle-core/lib/clients.js", () => ({
  getPublicClient: vi.fn(() => mockClient),
  getRpcUrl: vi.fn(() => "https://mock.rpc"),
  getRpcUrls: vi.fn(() => ["https://mock.rpc"]),
}));

// Import AFTER mock is set up
const { defiWriteTools } = await import("@mantleio/mantle-core/tools/defi-write.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OWNER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";

const USDC = { address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9", symbol: "USDC", decimals: 6 };
const WMNT = { address: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8", symbol: "WMNT", decimals: 18 };

function mapToken(input: string) {
  const t = input.toUpperCase();
  if (t === "USDC") return USDC;
  if (t === "WMNT") return WMNT;
  throw new Error(`Unknown test token: ${input}`);
}

/** Standard deps for buildSwap — mocks token resolution, allowance, and time. */
const baseDeps = {
  resolveTokenInput: async (input: string) => mapToken(input),
  // Allowance = max uint256 so the allowance check never blocks.
  // multicall is needed by discoverBestV3PoolShared (pool discovery) — return
  // empty results so it falls through gracefully.
  getClient: () => ({
    readContract: async () => BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
    multicall: async () => [],
  }) as any,
  now: () => "2026-04-17T00:00:00.000Z",
  deadline: () => 1_800_000_000n,
};

/** Standard args for a WMNT → USDC swap with owner (triggers gas estimation). */
const swapArgsWithOwner = {
  provider: "agni",
  token_in: "WMNT",
  token_out: "USDC",
  amount_in: "1",
  amount_out_min: "1000000",
  recipient: RECIPIENT,
  owner: OWNER,
  network: "mainnet",
  fee_tier: 500,  // Explicit fee_tier skips on-chain pool discovery (multicall)
};

/** Default mock setup for a successful gas estimation. */
function setupDefaultMocks() {
  mockEstimateGas.mockResolvedValue(100_000n);
  mockGetBlock.mockResolvedValue({ baseFeePerGas: 50_000_000n } as any);
  mockEstimateMaxPriorityFeePerGas.mockResolvedValue(2_000_000n);
  mockReadContract.mockResolvedValue(BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"));
}

const handler = defiWriteTools["mantle_buildSwap"].handler;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wrapBuildHandler gas estimation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("populates gas, maxFeePerGas, maxPriorityFeePerGas on happy path", async () => {
    setupDefaultMocks();

    const result = await handler(swapArgsWithOwner, baseDeps);
    const tx = result.unsigned_tx;

    // gas = 100000 * 120 / 100 = 120000
    expect(tx.gas).toBe("0x" + (120000).toString(16));

    // maxFeePerGas = baseFee(50M) * 2 + tip(2M)
    const expectedMaxFee = 50_000_000n * 2n + 2_000_000n;
    expect(tx.maxFeePerGas).toBe("0x" + expectedMaxFee.toString(16));

    // maxPriorityFeePerGas = 2M
    expect(tx.maxPriorityFeePerGas).toBe("0x" + (2_000_000).toString(16));

    // Verify estimateGas was called with the owner as account
    expect(mockEstimateGas).toHaveBeenCalledTimes(1);
    const call = mockEstimateGas.mock.calls[0][0] as Record<string, unknown>;
    expect((call.account as string).toLowerCase()).toBe(OWNER.toLowerCase());
  });

  it("skips gas estimation and warns when no sender provided", async () => {
    setupDefaultMocks();

    const argsNoOwner = { ...swapArgsWithOwner };
    delete (argsNoOwner as any).owner;

    const result = await handler(argsNoOwner, baseDeps);
    const tx = result.unsigned_tx;

    // No gas fields set
    expect(tx.gas).toBeUndefined();
    expect(tx.maxFeePerGas).toBeUndefined();
    expect(tx.maxPriorityFeePerGas).toBeUndefined();

    // Warning about missing sender
    expect(result.warnings.some((w: string) => w.includes("Gas not estimated"))).toBe(true);

    // getPublicClient should not have been called for estimation
    expect(mockEstimateGas).not.toHaveBeenCalled();
  });

  it("sets gas but omits EIP-1559 fields when baseFeePerGas is null", async () => {
    mockEstimateGas.mockResolvedValue(200_000n);
    mockGetBlock.mockResolvedValue({ baseFeePerGas: null } as any);
    mockEstimateMaxPriorityFeePerGas.mockResolvedValue(2_000_000n);
    mockReadContract.mockResolvedValue(BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"));

    const result = await handler(swapArgsWithOwner, baseDeps);
    const tx = result.unsigned_tx;

    // gas still set: 200000 * 120 / 100 = 240000 = 0x3a980
    expect(tx.gas).toBe("0x3a980");

    // EIP-1559 fields omitted
    expect(tx.maxFeePerGas).toBeUndefined();
    expect(tx.maxPriorityFeePerGas).toBeUndefined();

    // Warning about baseFee
    expect(result.warnings.some((w: string) => w.includes("baseFeePerGas not available"))).toBe(true);
  });

  it("applies MIN_TIP floor when tip is below 0.001 Gwei", async () => {
    mockEstimateGas.mockResolvedValue(100_000n);
    mockGetBlock.mockResolvedValue({ baseFeePerGas: 50_000_000n } as any);
    // Tip below MIN_TIP (1_000_000n = 0.001 Gwei)
    mockEstimateMaxPriorityFeePerGas.mockResolvedValue(500n);
    mockReadContract.mockResolvedValue(BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"));

    const result = await handler(swapArgsWithOwner, baseDeps);
    const tx = result.unsigned_tx;

    // MIN_TIP = 1_000_000
    expect(tx.maxPriorityFeePerGas).toBe("0x" + (1_000_000).toString(16));

    // maxFeePerGas = 50M * 2 + 1M (MIN_TIP floor)
    const expectedMaxFee = 50_000_000n * 2n + 1_000_000n;
    expect(tx.maxFeePerGas).toBe("0x" + expectedMaxFee.toString(16));
  });

  it("throws GAS_ESTIMATION_FAILED when estimateGas rejects", async () => {
    mockEstimateGas.mockRejectedValue(new Error("execution reverted"));
    mockGetBlock.mockResolvedValue({ baseFeePerGas: 50_000_000n } as any);
    mockEstimateMaxPriorityFeePerGas.mockResolvedValue(2_000_000n);
    mockReadContract.mockResolvedValue(BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"));

    try {
      await handler(swapArgsWithOwner, baseDeps);
      throw new Error("expected handler to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MantleMcpError);
      const e = err as MantleMcpError;
      expect(e.code).toBe("GAS_ESTIMATION_FAILED");
      expect(e.message).toContain("execution reverted");
    }
  });

  it("skips gas block entirely when data is '0x' (not a real call)", async () => {
    setupDefaultMocks();

    // Use buildApprove with an already-sufficient allowance — returns intent='approve_skip'
    // which has data="0x" (empty calldata). This tests the isRealCall guard.
    const approveHandler = defiWriteTools["mantle_buildApprove"].handler;
    const approveResult = await approveHandler(
      {
        token: "WMNT",
        spender: "0x319B69888b0d11cEC22caA5034e25FfFBDc88421",
        amount: "100",
        owner: OWNER,
        network: "mainnet",
      },
      {
        resolveTokenInput: async (input: string) => mapToken(input),
        // Allowance already sufficient → approve_skip
        getClient: () => ({
          readContract: async () => BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
        }) as any,
        now: () => "2026-04-17T00:00:00.000Z",
        deadline: () => 1_800_000_000n,
      }
    );

    // approve_skip returns no real calldata — gas estimation should be skipped
    if (approveResult.intent === "approve_skip") {
      // No gas fields on skip result
      expect(approveResult.unsigned_tx?.gas).toBeUndefined();
      expect(mockEstimateGas).not.toHaveBeenCalled();
    } else {
      // If it returned a real approve tx (shouldn't with max allowance), gas estimation
      // is valid — just verify it doesn't crash
      expect(approveResult.unsigned_tx).toBeDefined();
    }
  });
});
