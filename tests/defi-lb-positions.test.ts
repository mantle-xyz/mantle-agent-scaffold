import { describe, expect, it } from "vitest";
import { getLBPositions } from "@0xwh1sker/mantle-core/tools/defi-lp-read.js";

describe("LB positions tool", () => {
  it("returns empty when no known pairs exist", async () => {
    const result = (await getLBPositions(
      { owner: "0x1111111111111111111111111111111111111111", network: "mainnet" },
      {
        getClient: () => ({}),
        listMoePairs: () => [],
        resolveToken: async () => ({ address: "0x0", symbol: null, decimals: null }),
        now: () => "2026-04-11T00:00:00.000Z"
      }
    )) as any;

    expect(result.total_positions).toBe(0);
    expect(result.positions).toHaveLength(0);
    expect(result.coverage).toBe("known_pairs_only");
  });

  it("returns positions when user has liquidity in bins", async () => {
    const PAIR_ADDR = "0x48c1a89af1102cad358549e9bb16ae5f96cddfec";
    const TOKEN_X = "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9";
    const TOKEN_Y = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
    const ACTIVE_ID = 8388608; // typical LB active bin

    const mockClient = () => ({
      multicall: async ({ contracts }: { contracts: any[] }) => {
        // First multicall: getActiveId + getTokenX + getTokenY
        if (contracts.length === 3 && contracts[0].functionName === "getActiveId") {
          return [
            { status: "success", result: ACTIVE_ID },
            { status: "success", result: TOKEN_X },
            { status: "success", result: TOKEN_Y }
          ];
        }

        // Second multicall: bin balance reads (3 calls per bin)
        return contracts.map((c: any) => {
          const binId = c.args?.[1] ?? c.args?.[0];
          const binIdNum = typeof binId === "bigint" ? Number(binId) : binId;

          if (c.functionName === "balanceOf") {
            // User has balance only in active bin
            return {
              status: "success",
              result: binIdNum === ACTIVE_ID ? 500_000_000_000_000_000n : 0n
            };
          }
          if (c.functionName === "totalSupply") {
            return {
              status: "success",
              result: binIdNum === ACTIVE_ID ? 1_000_000_000_000_000_000n : 0n
            };
          }
          if (c.functionName === "getBin") {
            return {
              status: "success",
              result: binIdNum === ACTIVE_ID
                ? [2_000_000n, 3_000_000n] // 2 USDC, 3 USDT0
                : [0n, 0n]
            };
          }
          return { status: "success", result: 0n };
        });
      }
    });

    const result = (await getLBPositions(
      { owner: "0x1111111111111111111111111111111111111111", network: "mainnet" },
      {
        getClient: mockClient,
        listMoePairs: () => [{
          provider: "merchant_moe" as const,
          tokenA: "USDC", tokenB: "USDT0",
          tokenAAddress: TOKEN_X, tokenBAddress: TOKEN_Y,
          pool: PAIR_ADDR, binStep: 1, version: 2
        }],
        resolveToken: async (addr) => {
          if (addr === TOKEN_X) return { address: TOKEN_X, symbol: "USDC", decimals: 6 };
          if (addr === TOKEN_Y) return { address: TOKEN_Y, symbol: "USDT0", decimals: 6 };
          return { address: addr, symbol: null, decimals: null };
        },
        now: () => "2026-04-11T00:00:00.000Z"
      }
    )) as any;

    expect(result.total_positions).toBe(1);
    expect(result.positions[0].pair_address).toBe(PAIR_ADDR);
    expect(result.positions[0].token_x.symbol).toBe("USDC");
    expect(result.positions[0].token_y.symbol).toBe("USDT0");
    expect(result.positions[0].bins).toHaveLength(1);

    const bin = result.positions[0].bins[0];
    expect(bin.bin_id).toBe(ACTIVE_ID);
    expect(bin.share_pct).toBe(50); // 50%
    // 50% of 2_000_000 = 1_000_000 = 1.0 USDC
    expect(Number(bin.user_amount_x)).toBe(1);
    // 50% of 3_000_000 = 1_500_000 = 1.5 USDT0
    expect(Number(bin.user_amount_y)).toBe(1.5);
    // Raw values also present
    expect(bin.user_amount_x_raw).toBe("1000000");
    expect(bin.user_amount_y_raw).toBe("1500000");
  });

  it("returns heuristic warning when no positions found", async () => {
    const mockClient = () => ({
      multicall: async ({ contracts }: { contracts: any[] }) => {
        if (contracts.length === 3 && contracts[0].functionName === "getActiveId") {
          return [
            { status: "success", result: 100 },
            { status: "success", result: "0x1111111111111111111111111111111111111111" },
            { status: "success", result: "0x2222222222222222222222222222222222222222" }
          ];
        }
        return contracts.map(() => ({ status: "success", result: 0n }));
      }
    });

    const result = (await getLBPositions(
      { owner: "0x1111111111111111111111111111111111111111", network: "mainnet" },
      {
        getClient: mockClient,
        listMoePairs: () => [{
          provider: "merchant_moe" as const,
          tokenA: "A", tokenB: "B",
          tokenAAddress: "0x1111111111111111111111111111111111111111",
          tokenBAddress: "0x2222222222222222222222222222222222222222",
          pool: "0x3333333333333333333333333333333333333333",
          binStep: 20, version: 2
        }],
        resolveToken: async (addr) => ({ address: addr, symbol: "?", decimals: 18 }),
        now: () => "2026-04-11T00:00:00.000Z"
      }
    )) as any;

    expect(result.total_positions).toBe(0);
    // F-02: The note should explicitly warn about the heuristic limitation
    expect(result.note).toContain("NOT checked");
    expect(result.note).toContain("may still hold");
  });

  it("captures pair-level errors without failing the whole scan", async () => {
    const mockClient = () => ({
      multicall: async () => {
        throw new Error("RPC timeout");
      }
    });

    const result = (await getLBPositions(
      { owner: "0x1111111111111111111111111111111111111111", network: "mainnet" },
      {
        getClient: mockClient,
        listMoePairs: () => [{
          provider: "merchant_moe" as const,
          tokenA: "A", tokenB: "B",
          tokenAAddress: "0x1111111111111111111111111111111111111111",
          tokenBAddress: "0x2222222222222222222222222222222222222222",
          pool: "0x3333333333333333333333333333333333333333",
          binStep: 20, version: 2
        }],
        resolveToken: async (addr) => ({ address: addr, symbol: "?", decimals: 18 }),
        now: () => "2026-04-11T00:00:00.000Z"
      }
    )) as any;

    expect(result.total_positions).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain("RPC timeout");
  });

  it("throws on invalid address", async () => {
    await expect(
      getLBPositions({ owner: "not-an-address", network: "mainnet" })
    ).rejects.toThrow("must be a valid address");
  });
});
