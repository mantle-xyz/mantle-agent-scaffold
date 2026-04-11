import { describe, expect, it } from "vitest";
import { getAllowances, getBalance, getTokenBalances } from "@0xwh1sker/mantle-core/tools/account.js";

describe("account tools", () => {
  it("returns native MNT balance", async () => {
    const result = await getBalance(
      {
        address: "0x1111111111111111111111111111111111111111",
        network: "mainnet"
      },
      {
        getClient: () => ({
          getBlockNumber: async () => 999n,
          getBalance: async () => 1230000000000000000n
        }),
        now: () => "2026-02-28T00:00:00.000Z"
      }
    );

    expect(result.balance_wei).toBe("1230000000000000000");
    expect(result.balance_mnt).toBe("1.23");
    expect(result.block_number).toBe(999);
  });

  it("returns token balances and partial=true when one token read fails", async () => {
    let calls = 0;
    const result = await getTokenBalances(
      {
        address: "0x1111111111111111111111111111111111111111",
        tokens: ["USDC", "BADTOKEN"],
        network: "mainnet"
      },
      {
        getClient: () => ({
          getBlockNumber: async () => 1000n
        }),
        resolveTokenInput: async (token) => {
          if (token === "USDC") {
            return {
              address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
              symbol: "USDC",
              decimals: 6
            };
          }
          throw new Error("unknown token");
        },
        readTokenBalance: async () => {
          calls += 1;
          return 1234567n;
        },
        now: () => "2026-02-28T00:00:00.000Z"
      }
    );

    expect(calls).toBe(1);
    expect(result.partial).toBe(true);
    expect(result.balances).toHaveLength(2);
    expect(result.balances[0].balance_normalized).toBe("1.234567");
    expect(result.balances[1].error).toContain("unknown token");
  });

  it("reads allowances and marks unlimited values", async () => {
    const result = await getAllowances(
      {
        owner: "0x1111111111111111111111111111111111111111",
        pairs: [
          { token: "USDC", spender: "0x319B69888b0d11cEC22caA5034e25FfFBDc88421" }
        ],
        network: "mainnet"
      },
      {
        getClient: () => ({
          getBlockNumber: async () => 1001n
        }),
        resolveTokenInput: async () => ({
          address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
          symbol: "USDC",
          decimals: 6
        }),
        readTokenAllowance: async () => (2n ** 255n) + 1n,
        resolveSpenderLabel: () => "Agni Router",
        now: () => "2026-02-28T00:00:00.000Z"
      }
    );

    expect(result.partial).toBe(false);
    expect(result.allowances[0].token_symbol).toBe("USDC");
    expect(result.allowances[0].spender_label).toBe("Agni Router");
    expect(result.allowances[0].is_unlimited).toBe(true);
  });
});
