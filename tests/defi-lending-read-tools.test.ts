import { describe, expect, it } from "vitest";
import { getAavePositions } from "@0xwh1sker/mantle-core/tools/defi-lending-read.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/** Build a mock client that supports readContract and multicall. */
function mockClient(opts: {
  accountData?: [bigint, bigint, bigint, bigint, bigint, bigint];
  userConfigBitmap?: bigint;
  reserveDataResults?: Array<{ status: string; result?: any }>;
  balanceResults?: Array<{ status: string; result?: any }>;
}) {
  return () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "getUserAccountData") {
        return opts.accountData ?? [0n, 0n, 0n, 0n, 0n, 2n ** 256n - 1n];
      }
      if (functionName === "getUserConfiguration") {
        return opts.userConfigBitmap ?? 0n;
      }
      throw new Error(`Unexpected readContract: ${functionName}`);
    },
    multicall: async ({ contracts }: { contracts: any[] }) => {
      // First multicall = getReserveData calls (10 reserves)
      // Second multicall = balance reads
      if (contracts[0]?.functionName === "getReserveData") {
        return opts.reserveDataResults ?? contracts.map(() => ({
          status: "success",
          result: {
            stableDebtTokenAddress: ZERO_ADDR,
            9: ZERO_ADDR // fallback index access
          }
        }));
      }
      // Balance reads
      return opts.balanceResults ?? contracts.map(() => ({
        status: "success",
        result: 0n
      }));
    }
  });
}

describe("defi lending read tools", () => {
  it("returns no_debt for a wallet with zero positions", async () => {
    const result = (await getAavePositions(
      { user: "0x1111111111111111111111111111111111111111", network: "mainnet" },
      {
        getClient: mockClient({}),
        now: () => "2026-04-11T00:00:00.000Z"
      }
    )) as any;

    expect(result.protocol).toBe("aave_v3");
    expect(result.account.health_status).toBe("no_debt");
    expect(result.account.health_factor).toBeNull();
    expect(result.positions).toHaveLength(0);
    expect(result.partial).toBe(false);
  });

  it("returns positions for a wallet with supply and variable debt", async () => {
    // Supply 100 USDC (6 decimals), borrow 50 USDC variable
    // USDC is reserve index 3 → aToken at call idx 3*2=6, varDebt at 3*2+1=7
    const balanceResults: Array<{ status: string; result: bigint }> = [];
    for (let i = 0; i < 10; i++) {
      // aToken balance
      balanceResults.push({
        status: "success",
        result: i === 3 ? 100_000_000n : 0n // 100 USDC for reserve 3
      });
      // variableDebtToken balance
      balanceResults.push({
        status: "success",
        result: i === 3 ? 50_000_000n : 0n // 50 USDC debt for reserve 3
      });
      // No stable debt (stableDebtToken is zero address, so no 3rd call)
    }

    const result = (await getAavePositions(
      { user: "0x1111111111111111111111111111111111111111", network: "mainnet" },
      {
        getClient: mockClient({
          accountData: [
            100_00000000n, // totalCollateral: $100 (8 decimals)
            50_00000000n,  // totalDebt: $50
            30_00000000n,  // availableBorrows: $30
            8000n,         // liquidationThreshold: 80%
            7500n,         // ltv: 75%
            2_000000000000000000n // healthFactor: 2.0
          ],
          balanceResults
        }),
        now: () => "2026-04-11T00:00:00.000Z"
      }
    )) as any;

    expect(result.account.health_status).toBe("moderate"); // exactly 2.0 → moderate (> not >=)
    expect(Number(result.account.total_collateral_usd)).toBe(100);
    expect(Number(result.account.total_debt_usd)).toBe(50);
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].symbol).toBe("USDC");
    expect(Number(result.positions[0].supplied)).toBe(100);
    expect(Number(result.positions[0].variable_debt)).toBe(50);
    expect(Number(result.positions[0].stable_debt)).toBe(0);
    expect(result.total_supplied_positions).toBe(1);
    expect(result.total_borrowed_positions).toBe(1);
  });

  it("reads stable debt when stableDebtToken address is non-zero", async () => {
    const FAKE_STABLE_DEBT = "0x2222222222222222222222222222222222222222";

    // Reserve 2 (USDT0, 6 decimals) has stable debt
    const reserveDataResults = Array.from({ length: 10 }, (_, i) => ({
      status: "success" as const,
      result: {
        stableDebtTokenAddress: i === 2 ? FAKE_STABLE_DEBT : ZERO_ADDR,
        9: i === 2 ? FAKE_STABLE_DEBT : ZERO_ADDR
      }
    }));

    // Build balance results: for reserve 2, there are 3 calls (aToken + varDebt + stableDebt)
    const balanceResults: Array<{ status: string; result: bigint }> = [];
    for (let i = 0; i < 10; i++) {
      balanceResults.push({ status: "success", result: 0n }); // aToken
      balanceResults.push({ status: "success", result: 0n }); // varDebt
      if (i === 2) {
        balanceResults.push({ status: "success", result: 25_000_000n }); // stableDebt: 25 USDT0
      }
    }

    const result = (await getAavePositions(
      { user: "0x1111111111111111111111111111111111111111", network: "mainnet" },
      {
        getClient: mockClient({
          accountData: [0n, 25_00000000n, 0n, 0n, 0n, 1_500000000000000000n],
          reserveDataResults,
          balanceResults
        }),
        now: () => "2026-04-11T00:00:00.000Z"
      }
    )) as any;

    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].symbol).toBe("USDT0");
    expect(Number(result.positions[0].stable_debt)).toBe(25);
    expect(Number(result.positions[0].variable_debt)).toBe(0);
    expect(Number(result.positions[0].total_debt)).toBe(25);
    expect(result.positions[0].stable_debt_token).toBe(FAKE_STABLE_DEBT);
  });

  it("detects possible missing reserves when aggregate debt > per-reserve debt", async () => {
    // getUserAccountData says $100 collateral but we find zero per-reserve supply
    const result = (await getAavePositions(
      { user: "0x1111111111111111111111111111111111111111", network: "mainnet" },
      {
        getClient: mockClient({
          accountData: [100_00000000n, 0n, 50_00000000n, 8000n, 7500n, 2n ** 256n - 1n]
          // All balance reads default to 0
        }),
        now: () => "2026-04-11T00:00:00.000Z"
      }
    )) as any;

    expect(result.possible_missing_reserves).toBe(true);
    expect(result.possible_missing_reserves_note).toContain("new reserves");
  });

  it("classifies health statuses correctly", async () => {
    const testCases: Array<[bigint, string]> = [
      [2n ** 256n - 1n, "no_debt"],
      [3_000000000000000000n, "safe"],        // 3.0
      [2_100000000000000000n, "safe"],         // 2.1
      [2_000000000000000000n, "moderate"],     // exactly 2.0
      [1_500000000000000000n, "moderate"],     // 1.5
      [1_100000000000000000n, "at_risk"],      // exactly 1.1
      [1_050000000000000000n, "at_risk"],      // 1.05
      [1_000000000000000000n, "liquidatable"], // exactly 1.0
      [500000000000000000n, "liquidatable"]    // 0.5
    ];

    for (const [hf, expected] of testCases) {
      const result = (await getAavePositions(
        { user: "0x1111111111111111111111111111111111111111", network: "mainnet" },
        {
          getClient: mockClient({ accountData: [0n, 0n, 0n, 0n, 0n, hf] }),
          now: () => "2026-04-11T00:00:00.000Z"
        }
      )) as any;
      expect(result.account.health_status).toBe(expected);
    }
  });

  it("includes per-reserve collateral_enabled from getUserConfiguration bitmap", async () => {
    // WMNT (reserve id=1): collateral bit is at position 1*2+1 = 3
    // Set bit 3 to 1 → userConfigBitmap = 0b1000 = 8n
    const wmntCollateralBitmap = 1n << 3n; // bit 3 = WMNT collateral enabled

    // Supply 10 WMNT (reserve idx 1, 18 decimals)
    const balanceResults: Array<{ status: string; result: bigint }> = [];
    for (let i = 0; i < 10; i++) {
      balanceResults.push({
        status: "success",
        result: i === 1 ? 10_000000000000000000n : 0n // 10 WMNT
      });
      balanceResults.push({ status: "success", result: 0n }); // no debt
    }

    const result = (await getAavePositions(
      { user: "0x1111111111111111111111111111111111111111", network: "mainnet" },
      {
        getClient: mockClient({
          accountData: [10_00000000n, 0n, 5_00000000n, 8000n, 7500n, 2n ** 256n - 1n],
          userConfigBitmap: wmntCollateralBitmap,
          balanceResults
        }),
        now: () => "2026-04-11T00:00:00.000Z"
      }
    )) as any;

    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].symbol).toBe("WMNT");
    expect(result.positions[0].collateral_enabled).toBe(true);
  });

  it("reports collateral_enabled=false when bitmap bit is not set", async () => {
    // WMNT has supply but collateral bit is NOT set (bitmap = 0)
    const balanceResults: Array<{ status: string; result: bigint }> = [];
    for (let i = 0; i < 10; i++) {
      balanceResults.push({
        status: "success",
        result: i === 1 ? 10_000000000000000000n : 0n
      });
      balanceResults.push({ status: "success", result: 0n });
    }

    const result = (await getAavePositions(
      { user: "0x1111111111111111111111111111111111111111", network: "mainnet" },
      {
        getClient: mockClient({
          accountData: [0n, 0n, 0n, 0n, 0n, 2n ** 256n - 1n],
          userConfigBitmap: 0n, // no collateral flags set
          balanceResults
        }),
        now: () => "2026-04-11T00:00:00.000Z"
      }
    )) as any;

    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].symbol).toBe("WMNT");
    expect(result.positions[0].collateral_enabled).toBe(false);
  });

  it("throws on invalid address", async () => {
    await expect(
      getAavePositions({ user: "not-an-address", network: "mainnet" })
    ).rejects.toThrow("must be a valid address");
  });
});
