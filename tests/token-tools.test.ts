import { afterEach, describe, expect, it, vi } from "vitest";
import { MantleMcpError } from "@0xwh1sker/mantle-core/errors.js";
import { getTokenInfo, getTokenPrices, resolveToken } from "@0xwh1sker/mantle-core/tools/token.js";

describe("token tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads token info", async () => {
    const result = await getTokenInfo(
      { token: "USDC", network: "mainnet" },
      {
        resolveTokenInput: async () => ({
          address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
          symbol: "USDC",
          decimals: 6
        }),
        readTokenMetadata: async () => ({
          name: "USD Coin",
          symbol: "USDC",
          decimals: 6,
          totalSupply: 5000000000000n
        }),
        now: () => "2026-02-28T00:00:00.000Z"
      }
    );

    expect(result.address).toBe("0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9");
    expect(result.symbol).toBe("USDC");
    expect(result.total_supply_normalized).toBe("5000000");
  });

  it("resolves token with token-list match", async () => {
    const result = await resolveToken(
      { symbol: "USDC", network: "mainnet", require_token_list_match: true },
      {
        fetchTokenListSnapshot: async () => ({
          version: "test-snapshot",
          tokens: [
            {
              chainId: 5000,
              address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
              symbol: "USDC",
              decimals: 6
            }
          ]
        })
      }
    );

    expect(result.address).toBe("0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9");
    expect(result.token_list_match).toBe(true);
    expect(result.confidence).toBe("high");
  });

  it("throws TOKEN_REGISTRY_MISMATCH when canonical list conflicts", async () => {
    await expect(
      resolveToken(
        { symbol: "USDC", network: "mainnet", require_token_list_match: true },
        {
          fetchTokenListSnapshot: async () => ({
            version: "test-snapshot",
            tokens: [
              {
                chainId: 5000,
                address: "0x1111111111111111111111111111111111111111",
                symbol: "USDC",
                decimals: 6
              }
            ]
          })
        }
      )
    ).rejects.toMatchObject({
      code: "TOKEN_REGISTRY_MISMATCH"
    });
  });

  it("never fabricates missing prices", async () => {
    const result = await getTokenPrices({
      tokens: ["UNKNOWN"],
      base_currency: "usd",
      network: "mainnet"
    });
    expect(result.partial).toBe(true);
    expect(result.prices[0].price).toBeNull();
    expect(result.prices[0].source).toBe("none");
  });

  it("rejects empty token list for pricing", async () => {
    await expect(
      getTokenPrices({
        tokens: [],
        base_currency: "usd",
        network: "mainnet"
      })
    ).rejects.toMatchObject({
      code: "INVALID_INPUT"
    });
  });

  it("prices MNT from WMNT quote path and does not confuse it with mETH", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("api.dexscreener.com/tokens/v1/mantle/0x78c1b0c915c4faa5fffa6cabf0219da63d7f4cb8")) {
        return new Response(
          JSON.stringify([{ priceUsd: "1.23" }]),
          { status: 200 }
        );
      }
      if (url.includes("api.dexscreener.com/tokens/v1/mantle/0xcda86a272531e8640cd7f1a92c01839911b90bb0")) {
        return new Response(
          JSON.stringify([{ priceUsd: "2500" }]),
          { status: 200 }
        );
      }
      return new Response("[]", { status: 200 });
    });

    const mntOnly = await getTokenPrices({
      tokens: ["MNT"],
      base_currency: "usd",
      network: "mainnet"
    });
    expect(mntOnly.prices[0].symbol).toBe("MNT");
    expect(mntOnly.prices[0].price).toBe(1.23);

    const both = await getTokenPrices({
      tokens: ["MNT", "mETH"],
      base_currency: "usd",
      network: "mainnet"
    });
    expect(both.prices[0].symbol).toBe("MNT");
    expect(both.prices[0].price).toBe(1.23);
    expect(both.prices[1].symbol).toBe("mETH");
    expect(both.prices[1].price).toBe(2500);
  });
});
