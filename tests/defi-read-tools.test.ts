import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getLendingMarkets,
  getPoolLiquidity,
  getPoolOpportunities,
  getProtocolTvl,
  getSwapQuote
} from "@mantleio/mantle-core/tools/defi-read.js";

describe("defi read tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns swap quote from injected quote backend", async () => {
    const result = await getSwapQuote(
      {
        token_in: "USDC",
        token_out: "USDT0",
        amount_in: "100",
        provider: "agni",
        network: "mainnet"
      },
      {
        quoteProvider: async () => ({
          estimated_out_raw: "100000000",
          estimated_out_decimal: "100",
          price_impact_pct: 0.12,
          route: "USDC->USDT",
          fee_tier: 500
        }),
        now: () => "2026-02-28T00:00:00.000Z"
      }
    );

    expect(result.provider).toBe("agni");
    expect(result.token_in.symbol).toBe("USDC");
    expect(result.estimated_out_decimal).toBe("100");
    expect(result.minimum_out_decimal).toBe("99.5");
    expect(result.router_address).toBe("0x319B69888b0d11cEC22caA5034e25FfFBDc88421");
  });

  it("queries both providers in best mode and returns the better quote", async () => {
    const calls: string[] = [];
    const result = await getSwapQuote(
      {
        token_in: "USDC",
        token_out: "USDT0",
        amount_in: "100",
        provider: "best",
        network: "mainnet"
      },
      {
        quoteProvider: async ({ provider }) => {
          calls.push(provider);
          if (provider === "agni") {
            return {
              estimated_out_raw: "100000000",
              estimated_out_decimal: "100",
              price_impact_pct: 0.3,
              route: "USDC->USDT (agni)",
              fee_tier: 500
            };
          }
          return {
            estimated_out_raw: "101000000",
            estimated_out_decimal: "101",
            price_impact_pct: 0.2,
            route: "USDC->USDT (merchant_moe)",
            fee_tier: null
          };
        },
        now: () => "2026-02-28T00:00:00.000Z"
      }
    );

    expect(calls.sort()).toEqual(["agni", "fluxion", "merchant_moe"]);
    expect(result.provider).toBe("merchant_moe");
    expect(result.estimated_out_raw).toBe("101000000");
  });

  it("uses the surviving quote when one best-mode provider has no route", async () => {
    const result = await getSwapQuote(
      {
        token_in: "USDC",
        token_out: "USDT0",
        amount_in: "100",
        provider: "best",
        network: "mainnet"
      },
      {
        quoteProvider: async ({ provider }) => {
          if (provider === "agni") {
            return null;
          }
          return {
            estimated_out_raw: "100500000",
            estimated_out_decimal: "100.5",
            price_impact_pct: 0.1,
            route: "USDC->USDT (merchant_moe)",
            fee_tier: null
          };
        },
        now: () => "2026-02-28T00:00:00.000Z"
      }
    );

    expect(result.provider).toBe("merchant_moe");
    expect(result.estimated_out_decimal).toBe("100.5");
  });

  it("rejects same-token swaps", async () => {
    await expect(
      getSwapQuote({
        token_in: "USDC",
        token_out: "USDC",
        amount_in: "1",
        network: "mainnet"
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("returns pool liquidity with null usd and warning on degradation", async () => {
    const result = await getPoolLiquidity(
      {
        pool_address: "0x1111111111111111111111111111111111111111",
        provider: "agni",
        network: "mainnet"
      },
      {
        readPool: async () => ({
          token_0: {
            address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
            symbol: "USDC",
            decimals: 6
          },
          token_1: {
            address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
            symbol: "USDT",
            decimals: 6
          },
          reserve_0_raw: "5000000000",
          reserve_1_raw: "5000000000",
          fee_tier: 500
        }),
        getTokenPrices: async () => ({}),
        now: () => "2026-02-28T00:00:00.000Z"
      }
    );

    expect(result.total_liquidity_usd).toBeNull();
    expect(result.warnings.join(" ")).toContain("null");
  });

  it("derives pool liquidity USD when provider USD is unavailable", async () => {
    const result = await getPoolLiquidity(
      {
        pool_address: "0x1111111111111111111111111111111111111111",
        provider: "agni",
        network: "mainnet"
      },
      {
        readPool: async () => ({
          token_0: {
            address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
            symbol: "USDC",
            decimals: 6
          },
          token_1: {
            address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
            symbol: "USDT",
            decimals: 6
          },
          reserve_0_raw: "5000000000",
          reserve_1_raw: "5000000000",
          fee_tier: 500,
          total_liquidity_usd: null
        }),
        getTokenPrices: async () => ({
          "0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9": 1,
          "0x201eba5cc46d216ce6dc03f6a759e8e766e956ae": 1
        }),
        now: () => "2026-02-28T00:00:00.000Z"
      }
    );

    expect(result.total_liquidity_usd).toBe(10000);
    expect(result.warnings).toEqual([]);
  });

  it("returns typed error when pool reserve payload is invalid", async () => {
    await expect(
      getPoolLiquidity(
        {
          pool_address: "0x1111111111111111111111111111111111111111",
          provider: "agni",
          network: "mainnet"
        },
        {
          readPool: async () => ({
            token_0: {
              address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
              symbol: "USDC",
              decimals: 6
            },
            token_1: {
              address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
              symbol: "USDT",
              decimals: 6
            },
            reserve_0_raw: "not-a-bigint",
            reserve_1_raw: "5000000000",
            fee_tier: 500
          })
        }
      )
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("supports aave alias and keeps tvl_usd null when unavailable", async () => {
    const result = await getLendingMarkets(
      {
        protocol: "aave",
        asset: "USDC",
        network: "mainnet"
      },
      {
        marketProvider: async () => [
          {
            protocol: "aave_v3",
            asset: "USDC",
            asset_address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
            supply_apy: 2.3,
            borrow_apy_variable: 3.1,
            borrow_apy_stable: null,
            tvl_usd: null,
            ltv: 80,
            liquidation_threshold: 85,
            isolation_mode: false,
            debt_ceiling_usd: 0,
            borrowable_in_isolation: true,
            borrowing_enabled: true
          }
        ],
        now: () => "2026-02-28T00:00:00.000Z"
      }
    );

    expect(result.partial).toBe(false);
    expect(result.markets[0].protocol).toBe("aave_v3");
    expect(result.markets[0].tvl_usd).toBeNull();
  });

  it("throws typed error when aave market data is unavailable", async () => {
    await expect(
      getLendingMarkets(
        {
          protocol: "aave_v3",
          network: "mainnet"
        },
        {
          marketProvider: async () => [],
          now: () => "2026-02-28T00:00:00.000Z"
        }
      )
    ).rejects.toMatchObject({ code: "LENDING_DATA_UNAVAILABLE" });
  });

  it("uses DexScreener as default quote source for Agni", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("api.dexscreener.com/token-pairs/v1/mantle/")) {
        return new Response(
          JSON.stringify([
            {
              dexId: "agni",
              pairAddress: "0x6488f911c6Cd86c289aa319C5A826Dcf8F1cA065",
              baseToken: {
                address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
                symbol: "USDC"
              },
              quoteToken: {
                address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
                symbol: "USDT"
              },
              priceNative: "2",
              liquidity: { usd: 1000000 }
            }
          ]),
          { status: 200 }
        );
      }
      return new Response("[]", { status: 200 });
    });

    const result = await getSwapQuote({
      token_in: "USDC",
      token_out: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
      amount_in: "100",
      provider: "agni",
      network: "mainnet"
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(result.provider).toBe("agni");
    expect(result.estimated_out_raw).toBe("200000000");
    expect(result.route.toLowerCase()).toContain("dexscreener");
  });

  it("uses DexScreener pair endpoint as default pool source", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("api.dexscreener.com/latest/dex/pairs/mantle/")) {
        return new Response(
          JSON.stringify({
            pairs: [
              {
                dexId: "merchantmoe",
                pairAddress: "0x48C1A89af1102Cad358549e9Bb16aE5f96CddFEc",
                baseToken: {
                  address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
                  symbol: "USDC"
                },
                quoteToken: {
                  address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
                  symbol: "USDT"
                },
                liquidity: { usd: 30, base: 10, quote: 20 }
              }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response("[]", { status: 200 });
    });

    const result = await getPoolLiquidity({
      pool_address: "0x48C1A89af1102Cad358549e9Bb16aE5f96CddFEc",
      provider: "merchant_moe",
      network: "mainnet"
    });

    expect(result.total_liquidity_usd).toBe(30);
    expect(result.reserve_0_raw).toBe("10000000");
    expect(result.reserve_1_raw).toBe("20000000");
  });

  it("falls back to DefiLlama prices when DexScreener token prices are unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("api.dexscreener.com/latest/dex/pairs/mantle/")) {
        return new Response(
          JSON.stringify({
            pairs: [
              {
                dexId: "agni",
                pairAddress: "0x6488f911c6Cd86c289aa319C5A826Dcf8F1cA065",
                baseToken: {
                  address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
                  symbol: "USDC"
                },
                quoteToken: {
                  address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
                  symbol: "USDT"
                },
                liquidity: { usd: null, base: 5, quote: 5 }
              }
            ]
          }),
          { status: 200 }
        );
      }

      if (url.includes("api.dexscreener.com/tokens/v1/mantle/")) {
        return new Response("[]", { status: 200 });
      }

      if (url.includes("coins.llama.fi/prices/current/")) {
        return new Response(
          JSON.stringify({
            coins: {
              "mantle:0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9": { price: 2 },
              "mantle:0x201eba5cc46d216ce6dc03f6a759e8e766e956ae": { price: 1 }
            }
          }),
          { status: 200 }
        );
      }

      return new Response("{}", { status: 200 });
    });

    const result = await getPoolLiquidity({
      pool_address: "0x6488f911c6Cd86c289aa319C5A826Dcf8F1cA065",
      provider: "agni",
      network: "mainnet"
    });

    expect(result.total_liquidity_usd).toBe(15);
    expect(result.warnings).toEqual([]);
  });

  it("includes intent/source trace/confidence in best-route swap quote", async () => {
    const result = await getSwapQuote(
      {
        token_in: "USDC",
        token_out: "USDT0",
        amount_in: "100",
        provider: "best",
        network: "mainnet"
      },
      {
        quoteProvider: async ({ provider }) => {
          if (provider === "agni") {
            return {
              estimated_out_raw: "100000000",
              estimated_out_decimal: "100",
              price_impact_pct: 0.4,
              route: "agni-route",
              fee_tier: 500
            };
          }
          return {
            estimated_out_raw: "101000000",
            estimated_out_decimal: "101",
            price_impact_pct: 0.2,
            route: "merchant-route",
            fee_tier: null
          };
        }
      }
    );

    expect(result.intent).toBe("pool_quote");
    expect(Array.isArray(result.source_trace)).toBe(true);
    expect(result.source_trace.length).toBeGreaterThan(0);
    expect(result.confidence?.score).toBeTypeOf("number");
  });

  it("falls back from dexscreener to subgraph for pool liquidity and records trace", async () => {
    const result = await getPoolLiquidity(
      {
        pool_address: "0x1111111111111111111111111111111111111111",
        provider: "agni",
        network: "mainnet"
      },
      {
        readPool: async () => null,
        readPoolFromSubgraph: async () => ({
          token_0: {
            address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
            symbol: "USDC",
            decimals: 6
          },
          token_1: {
            address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
            symbol: "USDT",
            decimals: 6
          },
          reserve_0_raw: "5000000",
          reserve_1_raw: "7000000",
          fee_tier: null,
          total_liquidity_usd: 12
        }),
        readPoolFromIndexer: async () => null,
        getTokenPrices: async () => ({})
      }
    );

    expect(result.total_liquidity_usd).toBe(12);
    expect(result.intent).toBe("pool_liquidity");
    expect(result.source_trace.map((item: { source: string }) => item.source)).toContain("dexscreener");
    expect(result.source_trace.map((item: { source: string }) => item.source)).toContain("subgraph");
    expect(result.confidence?.score).toBeGreaterThan(0);
  });

  it("returns a liquidity usd range on source conflict", async () => {
    const result = await getPoolLiquidity(
      {
        pool_address: "0x1111111111111111111111111111111111111111",
        provider: "agni",
        network: "mainnet"
      },
      {
        readPool: async () => ({
          token_0: {
            address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
            symbol: "USDC",
            decimals: 6
          },
          token_1: {
            address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
            symbol: "USDT",
            decimals: 6
          },
          reserve_0_raw: "500000000",
          reserve_1_raw: "500000000",
          fee_tier: null,
          total_liquidity_usd: 500
        }),
        getTokenPrices: async () => ({
          "0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9": 2,
          "0x201eba5cc46d216ce6dc03f6a759e8e766e956ae": 1
        })
      }
    );

    expect(result.total_liquidity_usd_range).toEqual({ min: 500, max: 1500 });
    expect(result.warnings.join(" ")).toContain("conflict");
  });

  it("falls back from onchain to subgraph/indexer source for lending markets", async () => {
    const result = await getLendingMarkets(
      {
        protocol: "aave_v3",
        network: "mainnet"
      },
      {
        marketProvider: async () => [],
        marketProviderFromSubgraph: async () => [
          {
            protocol: "aave_v3",
            asset: "USDC",
            asset_address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
            supply_apy: 2.1,
            borrow_apy_variable: 3.4,
            borrow_apy_stable: null,
            tvl_usd: 1000000,
            ltv: 80,
            liquidation_threshold: 85,
            isolation_mode: false,
            debt_ceiling_usd: 0,
            borrowable_in_isolation: true,
            borrowing_enabled: true
          }
        ],
        marketProviderFromIndexer: async () => []
      }
    );

    expect(result.markets).toHaveLength(1);
    expect(result.intent).toBe("protocol_lending_markets");
    expect(result.partial).toBe(true);
    expect(result.source_trace.map((item: { source: string }) => item.source)).toContain("onchain_aave");
    expect(result.source_trace.map((item: { source: string }) => item.source)).toContain("subgraph");
    expect(result.confidence?.score).toBeGreaterThan(0);
  });

  it("returns protocol tvl from DefiLlama for agni", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("api.llama.fi/protocol/agni-finance")) {
        return new Response(
          JSON.stringify({
            name: "Agni Finance",
            chainTvls: {
              Mantle: {
                tvl: [{ date: 1772431979, totalLiquidityUSD: 33843354 }]
              }
            }
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    });

    const result = await getProtocolTvl({
      protocol: "agni",
      network: "mainnet"
    });

    expect(result.intent).toBe("protocol_tvl");
    expect(result.protocol).toBe("agni");
    expect(result.tvl_usd).toBe(33843354);
    expect(result.source_trace.map((item: { source: string }) => item.source)).toContain("defillama_protocol");
    expect(result.confidence?.score).toBeGreaterThan(0);
  });

  it("falls back to subgraph/indexer tvl source when DefiLlama is unavailable", async () => {
    const result = await getProtocolTvl(
      {
        protocol: "merchant_moe",
        network: "mainnet"
      },
      {
        protocolTvlProvider: async () => null,
        protocolTvlFromSubgraph: async () => null,
        protocolTvlFromIndexer: async () => 53995953
      }
    );

    expect(result.protocol).toBe("merchant_moe");
    expect(result.tvl_usd).toBe(53995953);
    expect(result.source_trace.map((item: { source: string }) => item.source)).toContain("indexer_sql");
    expect(result.partial).toBe(true);
  });

  it("returns tvl range on conflict between protocol tvl sources", async () => {
    const result = await getProtocolTvl(
      {
        protocol: "merchant_moe",
        network: "mainnet"
      },
      {
        protocolTvlProvider: async () => 50000000,
        protocolTvlFromSubgraph: async () => 80000000,
        protocolTvlFromIndexer: async () => null
      }
    );

    expect(result.tvl_usd_range).toEqual({ min: 50000000, max: 80000000 });
    expect(result.warnings.join(" ")).toContain("conflict");
  });

  it("scans and ranks WMNT/USDT pool opportunities from local registry with live enrichment", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input).toLowerCase();
      // Mock per-pool enrichment calls
      if (url.includes("latest/dex/pairs/mantle/0x365722f12ceb2063286a268b03c654df81b7c00f")) {
        return new Response(
          JSON.stringify({
            pairs: [
              {
                dexId: "merchantmoe",
                pairAddress: "0x365722f12ceb2063286A268B03c654Df81B7C00F",
                baseToken: {
                  address: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
                  symbol: "WMNT"
                },
                quoteToken: {
                  address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
                  symbol: "USDT"
                },
                liquidity: { usd: 1200000 },
                volume: { h24: 35000 }
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes("latest/dex/pairs/mantle/0xf6c9020c9e915808481757779edb53dacaee2415")) {
        return new Response(
          JSON.stringify({
            pairs: [
              {
                dexId: "merchantmoe",
                pairAddress: "0xf6C9020c9E915808481757779EDB53DACEaE2415",
                baseToken: {
                  address: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
                  symbol: "WMNT"
                },
                quoteToken: {
                  address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
                  symbol: "USDT"
                },
                liquidity: { usd: 19000 },
                volume: { h24: 5000 }
              }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response("[]", { status: 200 });
    });

    const result = await getPoolOpportunities({
      token_a: "WMNT",
      token_b: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
      provider: "merchant_moe",
      network: "mainnet"
    });

    expect(result.intent).toBe("pool_opportunity_scan");
    expect(result.token_a.symbol).toBe("WMNT");
    expect(result.token_b.symbol).toBe("USDT");
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
    expect(result.candidates[0].provider).toBe("merchant_moe");
    // Verify enrichment: live data should override static liquidity
    expect(result.candidates[0].liquidity_usd).toBe(1200000);
    expect(result.candidates[0].volume_24h_usd).toBe(35000);
  });
});
