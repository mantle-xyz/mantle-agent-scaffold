import { describe, expect, it } from "vitest";
import { buildAaveSetCollateral } from "@mantleio/mantle-core/tools/defi-write.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const USER = "0x1111111111111111111111111111111111111111" as const;
const WMNT_UNDERLYING = "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8";
const WMNT_ATOKEN = "0x85d86061e94CE01D3DA0f9EFa289c86ff136125a";

/**
 * Aave V3 reserve configuration bitmap builder.
 * Bits 0-15: LTV (bps), bit 56: active, bit 57: frozen
 */
function buildReserveConfig(opts: {
  ltvBps?: number;
  active?: boolean;
  frozen?: boolean;
}): bigint {
  let bitmap = BigInt(opts.ltvBps ?? 5000); // default 50% LTV
  if (opts.active !== false) bitmap |= 1n << 56n; // active by default
  if (opts.frozen) bitmap |= 1n << 57n;
  return bitmap;
}

/**
 * Build user configuration bitmap.
 * For reserve id `i`: bit i*2 = borrowing, bit i*2+1 = collateral
 */
function buildUserConfig(opts: {
  collateralReserveIds?: number[];
  borrowingReserveIds?: number[];
}): bigint {
  let bitmap = 0n;
  for (const id of opts.collateralReserveIds ?? []) {
    bitmap |= 1n << BigInt(id * 2 + 1);
  }
  for (const id of opts.borrowingReserveIds ?? []) {
    bitmap |= 1n << BigInt(id * 2);
  }
  return bitmap;
}

/** Build a mock deps object for buildAaveSetCollateral */
function mockDeps(opts: {
  aTokenBalance?: bigint;
  reserveConfig?: bigint;
  userConfig?: bigint;
  multicallFail?: boolean;
}) {
  return {
    getClient: () => ({
      multicall: async () => {
        if (opts.multicallFail) throw new Error("RPC error");
        return [
          { status: "success", result: opts.aTokenBalance ?? 10_000000000000000000n },
          { status: "success", result: opts.reserveConfig ?? buildReserveConfig({}) },
          { status: "success", result: opts.userConfig ?? 0n }
        ];
      },
      readContract: async () => 0n
    }),
    resolveToken: async () => ({
      symbol: "WMNT",
      address: WMNT_UNDERLYING,
      decimals: 18,
      name: "Wrapped MNT"
    }),
    now: () => "2026-04-12T00:00:00.000Z"
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildAaveSetCollateral", () => {
  it("builds correct calldata for setUserUseReserveAsCollateral", async () => {
    const result = (await buildAaveSetCollateral(
      { asset: "WMNT", user: USER },
      mockDeps({})
    )) as any;

    expect(result.intent).toBe("aave_set_collateral");
    expect(result.human_summary).toContain("Enable");
    expect(result.human_summary).toContain("WMNT");
    expect(result.unsigned_tx.data).toBeDefined();
    expect(result.unsigned_tx.value).toBe("0x0");
    // setUserUseReserveAsCollateral selector = 0x5a3b74b9
    expect(result.unsigned_tx.data.startsWith("0x5a3b74b9")).toBe(true);
  });

  it("generates different calldata for enable vs disable", async () => {
    const enable = (await buildAaveSetCollateral(
      { asset: "WMNT", user: USER, use_as_collateral: true },
      mockDeps({})
    )) as any;

    const disable = (await buildAaveSetCollateral(
      { asset: "WMNT", user: USER, use_as_collateral: false },
      mockDeps({})
    )) as any;

    // Both should have same function selector but different bool arg
    expect(enable.unsigned_tx.data).not.toBe(disable.unsigned_tx.data);
    expect(enable.human_summary).toContain("Enable");
    expect(disable.human_summary).toContain("Disable");
  });

  it("defaults to use_as_collateral=true when not specified", async () => {
    const result = (await buildAaveSetCollateral(
      { asset: "WMNT", user: USER },
      mockDeps({})
    )) as any;

    expect(result.human_summary).toContain("Enable");
  });

  it("parses use_as_collateral='false' string as false", async () => {
    const result = (await buildAaveSetCollateral(
      { asset: "WMNT", user: USER, use_as_collateral: "false" },
      mockDeps({})
    )) as any;

    expect(result.human_summary).toContain("Disable");
  });

  it("does NOT encode user address into the tx calldata", async () => {
    const resultA = (await buildAaveSetCollateral(
      { asset: "WMNT", user: "0x1111111111111111111111111111111111111111" },
      mockDeps({})
    )) as any;

    const resultB = (await buildAaveSetCollateral(
      { asset: "WMNT", user: "0x2222222222222222222222222222222222222222" },
      mockDeps({})
    )) as any;

    // Same calldata regardless of user — proves user is not encoded
    expect(resultA.unsigned_tx.data).toBe(resultB.unsigned_tx.data);
  });

  // ── Preflight diagnostic tests ──────────────────────────────────

  it("throws NO_SUPPLY_BALANCE when aToken balance is 0", async () => {
    await expect(
      buildAaveSetCollateral(
        { asset: "WMNT", user: USER },
        mockDeps({ aTokenBalance: 0n })
      )
    ).rejects.toThrow("no aToken balance");
  });

  it("throws RESERVE_NOT_ACTIVE when reserve is inactive", async () => {
    await expect(
      buildAaveSetCollateral(
        { asset: "WMNT", user: USER },
        mockDeps({ reserveConfig: buildReserveConfig({ active: false, ltvBps: 5000 }) })
      )
    ).rejects.toThrow("reserve is not active");
  });

  it("throws LTV_IS_ZERO when enabling collateral for reserve with LTV=0", async () => {
    await expect(
      buildAaveSetCollateral(
        { asset: "WMNT", user: USER },
        mockDeps({ reserveConfig: buildReserveConfig({ ltvBps: 0 }) })
      )
    ).rejects.toThrow("LTV is 0 basis points");
  });

  it("does NOT throw LTV_IS_ZERO when disabling collateral (LTV irrelevant)", async () => {
    const result = (await buildAaveSetCollateral(
      { asset: "WMNT", user: USER, use_as_collateral: false },
      mockDeps({ reserveConfig: buildReserveConfig({ ltvBps: 0 }) })
    )) as any;

    expect(result.intent).toBe("aave_set_collateral");
    expect(result.human_summary).toContain("Disable");
  });

  it("warns when collateral is already in desired state (no-op)", async () => {
    // WMNT = reserve id 1, collateral bit at position 3
    const result = (await buildAaveSetCollateral(
      { asset: "WMNT", user: USER, use_as_collateral: true },
      mockDeps({ userConfig: buildUserConfig({ collateralReserveIds: [1] }) })
    )) as any;

    expect(result.diagnostics.collateral_already_enabled).toBe(true);
    expect(result.diagnostics.diagnosis).toBe("already_in_desired_state");
    const noopWarning = result.warnings.find((w: string) => w.includes("NO-OP"));
    expect(noopWarning).toBeDefined();
  });

  it("warns about frozen reserve but still builds the tx", async () => {
    const result = (await buildAaveSetCollateral(
      { asset: "WMNT", user: USER },
      mockDeps({ reserveConfig: buildReserveConfig({ frozen: true }) })
    )) as any;

    expect(result.unsigned_tx.data).toBeDefined();
    const frozenWarning = result.warnings.find((w: string) => w.includes("FROZEN"));
    expect(frozenWarning).toBeDefined();
  });

  it("includes isolation mode warning for WMNT", async () => {
    const result = (await buildAaveSetCollateral(
      { asset: "WMNT", user: USER },
      mockDeps({})
    )) as any;

    const isoWarning = result.warnings.find((w: string) => w.includes("ISOLATION MODE"));
    expect(isoWarning).toBeDefined();
  });

  it("requires owner (deterministic contract) — rejects when owner is missing", async () => {
    // With the deterministic unsigned_tx contract, owner is mandatory:
    // setUserUseReserveAsCollateral operates on msg.sender, and we MUST pin
    // gas/nonce against a real signer. Missing owner is a hard failure, not
    // a "skip preflight" degraded mode.
    await expect(
      buildAaveSetCollateral({ asset: "WMNT" }, mockDeps({}))
    ).rejects.toThrow(/owner/i);
  });

  it("handles RPC errors gracefully during preflight", async () => {
    const result = (await buildAaveSetCollateral(
      { asset: "WMNT", user: USER },
      mockDeps({ multicallFail: true })
    )) as any;

    // Should still build the tx despite RPC failure
    expect(result.unsigned_tx.data).toBeDefined();
    expect(result.diagnostics.diagnosis).toBe("preflight_rpc_error");
  });

  it("returns diagnostics with reserve and user config data", async () => {
    const result = (await buildAaveSetCollateral(
      { asset: "WMNT", user: USER },
      mockDeps({
        aTokenBalance: 5_000000000000000000n, // 5 WMNT
        reserveConfig: buildReserveConfig({ ltvBps: 6250 }),
        userConfig: 0n // collateral not enabled
      })
    )) as any;

    expect(result.diagnostics.atoken_balance).toBe("5");
    expect(result.diagnostics.collateral_already_enabled).toBe(false);
    expect(result.diagnostics.reserve_ltv_bps).toBe(6250);
    expect(result.diagnostics.reserve_active).toBe(true);
    expect(result.diagnostics.reserve_frozen).toBe(false);
    expect(result.diagnostics.diagnosis).toBe("ok");
  });

  // ── Error cases ──────────────────────────────────────────────────

  it("throws on invalid asset symbol", async () => {
    await expect(
      buildAaveSetCollateral(
        { asset: "INVALID_TOKEN", user: USER },
        mockDeps({})
      )
    ).rejects.toThrow();
  });
});
