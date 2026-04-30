import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  crossValidatePrices,
  fetchCoinGeckoTokenPriceUsd,
  fetchDefiLlamaTokenPriceUsd,
  fetchDexScreenerTokenPriceUsd,
  getCrossValidatedPrice,
  getCrossValidatedPrices
} from "@mantleio/mantle-core/lib/price-oracle.js";

const USDC = "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9";
const WETH = "0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111";
const USDC_LOWER = USDC.toLowerCase();
const WETH_LOWER = WETH.toLowerCase();

const ENV_KEYS = ["COINGECKO_PRO_API_KEY", "COINGECKO_DEMO_API_KEY", "COINGECKO_API_KEY"];
let envBackup: Record<string, string | undefined> = {};

type FetchRoutes = {
  coingecko?: Record<string, number | null>;
  dexscreener?: Record<string, any[] | null>;
  defillama?: Record<string, number | null>;
  status?: Partial<Record<"coingecko" | "dexscreener" | "defillama", number>>;
};

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!headers) return normalized;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      normalized[key.toLowerCase()] = value;
    });
    return normalized;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) normalized[key.toLowerCase()] = value;
    return normalized;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function dsPair(baseAddress: string, priceUsd: number, liquidityUsd: number) {
  return {
    baseToken: { address: baseAddress },
    priceUsd: String(priceUsd),
    liquidity: { usd: liquidityUsd }
  };
}

function installFetchRouter(routes: FetchRoutes) {
  const calls = {
    coingecko: 0,
    dexscreener: 0,
    defillama: 0,
    urls: [] as string[],
    lastHeaders: null as Record<string, string> | null
  };

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.urls.push(url);

    if (url.includes("coingecko.com/api/v3/simple/token_price/mantle")) {
      calls.coingecko += 1;
      calls.lastHeaders = normalizeHeaders(init?.headers);
      const status = routes.status?.coingecko ?? 200;
      if (status !== 200) return new Response("{}", { status });
      const body: Record<string, { usd: number }> = {};
      for (const [address, price] of Object.entries(routes.coingecko ?? {})) {
        if (price != null) body[address.toLowerCase()] = { usd: price };
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }

    const dsMatch = url.match(/dexscreener\.com\/tokens\/v1\/mantle\/(0x[a-fA-F0-9]+)/);
    if (dsMatch) {
      calls.dexscreener += 1;
      const status = routes.status?.dexscreener ?? 200;
      if (status !== 200) return new Response("[]", { status });
      const address = dsMatch[1].toLowerCase();
      return new Response(JSON.stringify(routes.dexscreener?.[address] ?? []), { status: 200 });
    }

    if (url.includes("coins.llama.fi/prices/current/")) {
      calls.defillama += 1;
      const status = routes.status?.defillama ?? 200;
      if (status !== 200) return new Response("{}", { status });
      const coins: Record<string, { price: number; symbol: string; decimals: number }> = {};
      for (const [address, price] of Object.entries(routes.defillama ?? {})) {
        if (price != null) {
          coins[`mantle:${address.toLowerCase()}`] = { price, symbol: "TEST", decimals: 18 };
        }
      }
      return new Response(JSON.stringify({ coins }), { status: 200 });
    }

    return new Response("{}", { status: 404 });
  });

  return calls;
}

function logOracleCase(label: string, value: unknown) {
  console.info(
    `[price-oracle] ${label}: ${JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item, 2)}`
  );
}

beforeEach(() => {
  envBackup = {};
  for (const key of ENV_KEYS) {
    envBackup[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (envBackup[key] == null) delete process.env[key];
    else process.env[key] = envBackup[key];
  }
});

describe("price-oracle source fetchers", () => {
  it("fetches CoinGecko token prices using lowercase Mantle contract addresses", async () => {
    const calls = installFetchRouter({
      coingecko: { [USDC_LOWER]: 1.004 }
    });

    const price = await fetchCoinGeckoTokenPriceUsd("mainnet", USDC);
    logOracleCase("coingecko fetch", { price, url: calls.urls[0] });

    expect(price).toBe(1.004);

    expect(calls.coingecko).toBe(1);
    expect(calls.urls[0]).toContain(`contract_addresses=${USDC_LOWER}`);
  });

  it("sends CoinGecko demo and pro API key headers", async () => {
    process.env.COINGECKO_DEMO_API_KEY = "demo-key";
    let calls = installFetchRouter({ coingecko: { [USDC_LOWER]: 1 } });

    await fetchCoinGeckoTokenPriceUsd("mainnet", USDC);
    logOracleCase("coingecko demo headers", calls.lastHeaders);
    expect(calls.lastHeaders?.["x-cg-demo-api-key"]).toBe("demo-key");

    vi.restoreAllMocks();
    process.env.COINGECKO_PRO_API_KEY = "pro-key";
    calls = installFetchRouter({ coingecko: { [USDC_LOWER]: 1 } });

    await fetchCoinGeckoTokenPriceUsd("mainnet", USDC);
    logOracleCase("coingecko pro headers", { url: calls.urls[0], headers: calls.lastHeaders });
    expect(calls.urls[0]).toContain("pro-api.coingecko.com");
    expect(calls.lastHeaders?.["x-cg-pro-api-key"]).toBe("pro-key");
    expect(calls.lastHeaders?.["x-cg-demo-api-key"]).toBeUndefined();
  });

  it("fetches DexScreener token price from the highest-liquidity base-token pair", async () => {
    installFetchRouter({
      dexscreener: {
        [USDC_LOWER]: [
          dsPair(WETH, 2340, 1_000_000),
          dsPair(USDC, 0.98, 10_000),
          dsPair(USDC, 1.01, 50_000)
        ]
      }
    });

    const price = await fetchDexScreenerTokenPriceUsd("mainnet", USDC);
    logOracleCase("dexscreener pair selection", { selectedPrice: price, requested: USDC_LOWER });

    expect(price).toBe(1.01);
  });

  it("fetches DefiLlama token prices by mantle coin key", async () => {
    const calls = installFetchRouter({
      defillama: { [WETH_LOWER]: 2341.25 }
    });

    const price = await fetchDefiLlamaTokenPriceUsd("mainnet", WETH);
    logOracleCase("defillama fetch", { price, url: calls.urls[0] });

    expect(price).toBe(2341.25);

    expect(calls.defillama).toBe(1);
    expect(calls.urls[0]).toContain(`mantle:${WETH_LOWER}`);
  });

  it("does not call external sources on sepolia", async () => {
    const calls = installFetchRouter({
      coingecko: { [USDC_LOWER]: 1 },
      dexscreener: { [USDC_LOWER]: [dsPair(USDC, 1, 1_000)] },
      defillama: { [USDC_LOWER]: 1 }
    });

    await expect(fetchCoinGeckoTokenPriceUsd("sepolia", USDC)).resolves.toBeNull();
    await expect(fetchDexScreenerTokenPriceUsd("sepolia", USDC)).resolves.toBeNull();
    await expect(fetchDefiLlamaTokenPriceUsd("sepolia", USDC)).resolves.toBeNull();

    logOracleCase("sepolia external calls", calls);
    expect(calls.coingecko + calls.dexscreener + calls.defillama).toBe(0);
  });
});

describe("price-oracle cross validation", () => {
  it("returns high confidence when all three sources agree within 3%", () => {
    const validation = crossValidatePrices(1, 1.01, 0.99);
    logOracleCase("cross validate high", validation);

    expect(validation).toMatchObject({
      price: 1,
      source: "coingecko",
      confidence: "high",
      warnings: []
    });
  });

  it("returns medium confidence when CoinGecko and secondaries differ within 15%", () => {
    const validation = crossValidatePrices(1, 1.1, 1.08);
    logOracleCase("cross validate medium", validation);

    expect(validation.price).toBe(1);
    expect(validation.source).toBe("coingecko");
    expect(validation.confidence).toBe("medium");
    expect(validation.warnings[0]).toMatch(/diverge/i);
  });

  it("returns low confidence when only one secondary source is available", () => {
    const validation = crossValidatePrices(null, null, 2341.25);
    logOracleCase("cross validate single-source", validation);

    expect(validation).toMatchObject({
      price: 2341.25,
      source: "defillama",
      confidence: "low",
      price_sources: {
        coingecko: null,
        dexscreener: null,
        defillama: 2341.25
      }
    });
    expect(validation.warnings[0]).toMatch(/sole source/i);
  });
});

describe("price-oracle aggregate API", () => {
  it("queries all three sources and returns high confidence when they agree", async () => {
    const calls = installFetchRouter({
      coingecko: { [USDC_LOWER]: 1.004 },
      dexscreener: { [USDC_LOWER]: [dsPair(USDC, 1.003, 50_000)] },
      defillama: { [USDC_LOWER]: 1.006 }
    });

    const validation = await getCrossValidatedPrice("mainnet", USDC);
    logOracleCase("aggregate high confidence", {
      validation,
      calls: {
        coingecko: calls.coingecko,
        dexscreener: calls.dexscreener,
        defillama: calls.defillama
      }
    });

    expect(validation).toMatchObject({
      price: 1.004,
      source: "coingecko",
      confidence: "high",
      price_sources: {
        coingecko: 1.004,
        dexscreener: 1.003,
        defillama: 1.006
      }
    });
    expect(calls.coingecko).toBe(1);
    expect(calls.dexscreener).toBe(1);
    expect(calls.defillama).toBe(1);
  });

  it("falls back to DefiLlama low confidence when CoinGecko and DexScreener fail", async () => {
    installFetchRouter({
      coingecko: { [USDC_LOWER]: null },
      dexscreener: { [USDC_LOWER]: [] },
      defillama: { [USDC_LOWER]: 1.0068 }
    });

    const validation = await getCrossValidatedPrice("mainnet", USDC);
    logOracleCase("aggregate defillama fallback", validation);

    expect(validation.price).toBe(1.0068);
    expect(validation.source).toBe("defillama");
    expect(validation.confidence).toBe("low");
  });

  it("returns empty warnings and does not call fetch for non-mainnet networks", async () => {
    const calls = installFetchRouter({
      coingecko: { [USDC_LOWER]: 1 },
      dexscreener: { [USDC_LOWER]: [dsPair(USDC, 1, 1_000)] },
      defillama: { [USDC_LOWER]: 1 }
    });

    const validation = await getCrossValidatedPrice("sepolia", USDC);
    logOracleCase("aggregate sepolia", { validation, calls });

    expect(validation).toEqual({
      price: null,
      source: "none",
      confidence: "low",
      warnings: [],
      price_sources: { coingecko: null, dexscreener: null, defillama: null }
    });
    expect(calls.coingecko + calls.dexscreener + calls.defillama).toBe(0);
  });

  it("deduplicates addresses in batch price lookup", async () => {
    const calls = installFetchRouter({
      coingecko: {
        [USDC_LOWER]: 1,
        [WETH_LOWER]: 2340
      },
      dexscreener: {
        [USDC_LOWER]: [dsPair(USDC, 1, 50_000)],
        [WETH_LOWER]: [dsPair(WETH, 2341, 100_000)]
      },
      defillama: {
        [USDC_LOWER]: 1,
        [WETH_LOWER]: 2342
      }
    });

    const prices = await getCrossValidatedPrices("mainnet", [USDC, USDC_LOWER, WETH]);
    logOracleCase("batch dedupe", {
      keys: Object.keys(prices).sort(),
      usdc: prices[USDC_LOWER],
      weth: prices[WETH_LOWER],
      calls: {
        coingecko: calls.coingecko,
        dexscreener: calls.dexscreener,
        defillama: calls.defillama
      }
    });

    expect(Object.keys(prices).sort()).toEqual([USDC_LOWER, WETH_LOWER]);
    expect(prices[USDC_LOWER].confidence).toBe("high");
    expect(prices[WETH_LOWER].confidence).toBe("high");
    expect(calls.coingecko).toBe(2);
    expect(calls.dexscreener).toBe(2);
    expect(calls.defillama).toBe(2);
  });
});
