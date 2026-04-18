import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTokenPrices } from "@mantleio/mantle-core/tools/token.js";
import { __testFetchTokenPriceUsd as fetchTokenPriceUsd } from "@mantleio/mantle-core/tools/defi-write.js";

// Canonical Mantle addresses (all lowercase in URLs).
const WMNT = "0x78c1b0c915c4faa5fffa6cabf0219da63d7f4cb8";
const METH = "0xe6829d9a7ee3040e1276fa75293bde931859e8fa";
const USDC = "0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9";

/* ------------------------------------------------------------------ */
/*  Mock router — builds per-URL responses for CG / DS / DL endpoints    */
/* ------------------------------------------------------------------ */

type FetchRoute = {
  coingecko?: Record<string, number | null>; // keyed by lowercase addr → usd or null
  coingeckoStatus?: number; // override HTTP status (e.g. 500 for retry tests)
  dexscreener?: Record<string, any[] | null>; // addr → raw pair array OR null (404)
  dexscreenerStatus?: number;
  defillama?: Record<string, number | null>;
  defillamaStatus?: number;
};

interface CallTally {
  coingecko: number;
  dexscreener: number;
  defillama: number;
  lastCoingeckoUrl: string | null;
  lastCoingeckoHeaders: Record<string, string> | null;
}

function installFetchRouter(routes: FetchRoute): CallTally {
  const tally: CallTally = {
    coingecko: 0,
    dexscreener: 0,
    defillama: 0,
    lastCoingeckoUrl: null,
    lastCoingeckoHeaders: null
  };

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const headers = normalizeHeaders(init?.headers);

    // ---------- CoinGecko ----------
    if (url.includes("coingecko.com/api/v3/simple/token_price/mantle")) {
      tally.coingecko += 1;
      tally.lastCoingeckoUrl = url;
      tally.lastCoingeckoHeaders = headers;
      if (routes.coingeckoStatus != null && routes.coingeckoStatus !== 200) {
        return new Response("{}", { status: routes.coingeckoStatus });
      }
      const map = routes.coingecko ?? {};
      const body: Record<string, { usd: number } | undefined> = {};
      for (const [addr, usd] of Object.entries(map)) {
        if (usd != null) body[addr.toLowerCase()] = { usd };
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }

    // ---------- DexScreener ----------
    const dsMatch = url.match(/dexscreener\.com\/tokens\/v1\/mantle\/(0x[a-fA-F0-9]+)/);
    if (dsMatch) {
      tally.dexscreener += 1;
      if (routes.dexscreenerStatus != null && routes.dexscreenerStatus !== 200) {
        return new Response("[]", { status: routes.dexscreenerStatus });
      }
      const addr = dsMatch[1].toLowerCase();
      const pairs = routes.dexscreener?.[addr];
      if (pairs == null) return new Response("[]", { status: 200 });
      return new Response(JSON.stringify(pairs), { status: 200 });
    }

    // ---------- DefiLlama ----------
    if (url.includes("coins.llama.fi/prices/current/")) {
      tally.defillama += 1;
      if (routes.defillamaStatus != null && routes.defillamaStatus !== 200) {
        return new Response("{}", { status: routes.defillamaStatus });
      }
      const coins: Record<string, { price: number; symbol: string; decimals: number }> = {};
      for (const [addr, price] of Object.entries(routes.defillama ?? {})) {
        if (price != null) {
          coins[`mantle:${addr.toLowerCase()}`] = { price, symbol: "TEST", decimals: 18 };
        }
      }
      return new Response(JSON.stringify({ coins }), { status: 200 });
    }

    return new Response("{}", { status: 404 });
  });

  return tally;
}

function normalizeHeaders(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => (out[k.toLowerCase()] = v));
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = v;
    return out;
  }
  for (const [k, v] of Object.entries(h as Record<string, string>)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

/** Build a minimal DexScreener pair record. */
function dsPair(base: string, priceUsd: number, liquidityUsd: number) {
  return {
    baseToken: { address: base },
    priceUsd: String(priceUsd),
    liquidity: { usd: liquidityUsd }
  };
}

/* ------------------------------------------------------------------ */
/*  Setup / teardown                                                     */
/* ------------------------------------------------------------------ */

const ENV_KEYS = ["COINGECKO_PRO_API_KEY", "COINGECKO_DEMO_API_KEY", "COINGECKO_API_KEY"];
let envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  envBackup = {};
  for (const k of ENV_KEYS) {
    envBackup[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (envBackup[k] == null) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

/* ====================================================================== */
/*  token.ts — cross-validation algorithm via getTokenPrices public API      */
/* ====================================================================== */

describe("token.ts getTokenPrices — cross-source validation", () => {
  it("all three sources agree within 3% → high confidence, source=coingecko, no warnings", async () => {
    installFetchRouter({
      coingecko: { [METH]: 2500 },
      dexscreener: { [METH]: [dsPair(METH, 2502, 10_000_000)] },
      defillama: { [METH]: 2498 }
    });

    const result = await getTokenPrices({
      tokens: ["cmETH"],
      base_currency: "usd",
      network: "mainnet"
    });

    const p = result.prices[0];
    expect(p.price).toBe(2500);
    expect(p.source).toBe("coingecko");
    expect(p.confidence).toBe("high");
    expect(p.warnings).toEqual([]);
    expect(p.price_sources).toEqual({ coingecko: 2500, dexscreener: 2502, defillama: 2498 });
  });

  it("CoinGecko + secondaries diverge 3–15% → medium confidence + warning", async () => {
    installFetchRouter({
      coingecko: { [METH]: 2500 },
      dexscreener: { [METH]: [dsPair(METH, 2700, 10_000_000)] }, // 8% off
      defillama: { [METH]: 2520 }
    });

    const p = (await getTokenPrices({
      tokens: ["cmETH"],
      base_currency: "usd",
      network: "mainnet"
    })).prices[0];

    expect(p.price).toBe(2500);
    expect(p.source).toBe("coingecko");
    expect(p.confidence).toBe("medium");
    expect(p.warnings.length).toBeGreaterThan(0);
    expect(p.warnings[0]).toMatch(/diverge/i);
  });

  it("CoinGecko + secondaries diverge >15% → low confidence + loud warning", async () => {
    installFetchRouter({
      coingecko: { [METH]: 2500 },
      dexscreener: { [METH]: [dsPair(METH, 4000, 10_000_000)] }, // 60% off
      defillama: { [METH]: 2510 }
    });

    const p = (await getTokenPrices({
      tokens: ["cmETH"],
      base_currency: "usd",
      network: "mainnet"
    })).prices[0];

    expect(p.price).toBe(2500);
    expect(p.source).toBe("coingecko");
    expect(p.confidence).toBe("low");
    expect(p.warnings[0]).toMatch(/Significant price divergence/i);
  });

  it("CoinGecko alone → medium confidence + unverified warning", async () => {
    installFetchRouter({
      coingecko: { [METH]: 2500 }
      // no dex, no llama responses
    });

    const p = (await getTokenPrices({
      tokens: ["cmETH"],
      base_currency: "usd",
      network: "mainnet"
    })).prices[0];

    expect(p.price).toBe(2500);
    expect(p.source).toBe("coingecko");
    expect(p.confidence).toBe("medium");
    expect(p.warnings[0]).toMatch(/unverified/i);
  });

  it("CoinGecko unavailable, DS and DL agree → source=dexscreener, medium confidence", async () => {
    installFetchRouter({
      coingecko: {},
      dexscreener: { [METH]: [dsPair(METH, 2500, 10_000_000)] },
      defillama: { [METH]: 2505 } // <3%
    });

    const p = (await getTokenPrices({
      tokens: ["cmETH"],
      base_currency: "usd",
      network: "mainnet"
    })).prices[0];

    expect(p.price).toBe(2500);
    expect(p.source).toBe("dexscreener");
    expect(p.confidence).toBe("medium");
    expect(p.warnings[0]).toMatch(/CoinGecko unavailable/i);
  });

  it("CoinGecko unavailable, DS and DL disagree → source=aggregate (average), low confidence", async () => {
    installFetchRouter({
      coingecko: {},
      dexscreener: { [METH]: [dsPair(METH, 2000, 10_000_000)] },
      defillama: { [METH]: 3000 } // 50% apart
    });

    const p = (await getTokenPrices({
      tokens: ["cmETH"],
      base_currency: "usd",
      network: "mainnet"
    })).prices[0];

    expect(p.price).toBe(2500); // average
    expect(p.source).toBe("aggregate");
    expect(p.confidence).toBe("low");
    expect(p.warnings[0]).toMatch(/average/i);
  });

  it("only DexScreener reachable → source=dexscreener, low confidence", async () => {
    installFetchRouter({
      coingecko: {},
      dexscreener: { [METH]: [dsPair(METH, 2500, 10_000_000)] },
      defillama: {}
    });

    const p = (await getTokenPrices({
      tokens: ["cmETH"],
      base_currency: "usd",
      network: "mainnet"
    })).prices[0];

    expect(p.price).toBe(2500);
    expect(p.source).toBe("dexscreener");
    expect(p.confidence).toBe("low");
    expect(p.warnings[0]).toMatch(/sole source/i);
  });

  it("only DefiLlama reachable → source=defillama, low confidence", async () => {
    installFetchRouter({
      coingecko: {},
      dexscreener: {},
      defillama: { [METH]: 2500 }
    });

    const p = (await getTokenPrices({
      tokens: ["cmETH"],
      base_currency: "usd",
      network: "mainnet"
    })).prices[0];

    expect(p.price).toBe(2500);
    expect(p.source).toBe("defillama");
    expect(p.confidence).toBe("low");
    expect(p.warnings[0]).toMatch(/sole source/i);
  });

  it("no source reachable → price=null, source=none", async () => {
    installFetchRouter({ coingecko: {}, dexscreener: {}, defillama: {} });

    const p = (await getTokenPrices({
      tokens: ["cmETH"],
      base_currency: "usd",
      network: "mainnet"
    })).prices[0];

    expect(p.price).toBeNull();
    expect(p.source).toBe("none");
  });

  it("price_sources field exposes raw values from every upstream", async () => {
    installFetchRouter({
      coingecko: { [METH]: 2500 },
      dexscreener: { [METH]: [dsPair(METH, 2510, 10_000_000)] },
      defillama: { [METH]: 2490 }
    });

    const p = (await getTokenPrices({
      tokens: ["cmETH"],
      base_currency: "usd",
      network: "mainnet"
    })).prices[0];

    expect(p.price_sources).toEqual({
      coingecko: 2500,
      dexscreener: 2510,
      defillama: 2490
    });
  });
});

describe("token.ts — DexScreener pair selection", () => {
  it("prefers baseToken=queried pairs, then sorts by liquidity.usd desc", async () => {
    installFetchRouter({
      coingecko: {}, // force DS-only so we can observe the chosen priceUsd
      defillama: {},
      dexscreener: {
        [METH]: [
          dsPair("0xdeadbeef00000000000000000000000000000001", 1.0, 100_000_000), // higher liq but wrong baseToken
          dsPair(METH, 9999, 1_000), // a manipulated low-liquidity pair returned first
          dsPair(METH, 2500, 50_000_000) // real pair
        ]
      }
    });

    const p = (await getTokenPrices({
      tokens: ["cmETH"],
      base_currency: "usd",
      network: "mainnet"
    })).prices[0];

    expect(p.price).toBe(2500); // picked the high-liquidity baseToken pair, not the manipulated one
    expect(p.source).toBe("dexscreener");
  });

  it("falls back to the highest-liquidity pair when no baseToken match exists", async () => {
    installFetchRouter({
      coingecko: {},
      defillama: {},
      dexscreener: {
        [METH]: [
          dsPair("0xAAAA000000000000000000000000000000000001", 10, 1_000),
          dsPair("0xBBBB000000000000000000000000000000000002", 20, 500_000)
        ]
      }
    });

    const p = (await getTokenPrices({
      tokens: ["cmETH"],
      base_currency: "usd",
      network: "mainnet"
    })).prices[0];

    expect(p.price).toBe(20); // highest liquidity (500_000) wins over the 1000-liquidity 10-USD pair
  });
});

describe("token.ts — CoinGecko tier auto-detection", () => {
  it("no API key → hits free public base, no auth header", async () => {
    const tally = installFetchRouter({ coingecko: { [METH]: 2500 } });

    await getTokenPrices({
      tokens: ["cmETH"],
      base_currency: "usd",
      network: "mainnet"
    });

    expect(tally.lastCoingeckoUrl).not.toBeNull();
    expect(tally.lastCoingeckoUrl!).toContain("api.coingecko.com");
    expect(tally.lastCoingeckoUrl!).not.toContain("pro-api.coingecko.com");
    expect(tally.lastCoingeckoHeaders).not.toBeNull();
    expect(tally.lastCoingeckoHeaders!["x-cg-pro-api-key"]).toBeUndefined();
    expect(tally.lastCoingeckoHeaders!["x-cg-demo-api-key"]).toBeUndefined();
  });

  it("COINGECKO_DEMO_API_KEY → public base + x-cg-demo-api-key header", async () => {
    process.env.COINGECKO_DEMO_API_KEY = "demo-key-abc";
    const tally = installFetchRouter({ coingecko: { [METH]: 2500 } });

    await getTokenPrices({
      tokens: ["cmETH"],
      base_currency: "usd",
      network: "mainnet"
    });

    expect(tally.lastCoingeckoUrl!).toContain("api.coingecko.com");
    expect(tally.lastCoingeckoUrl!).not.toContain("pro-api.coingecko.com");
    expect(tally.lastCoingeckoHeaders!["x-cg-demo-api-key"]).toBe("demo-key-abc");
    expect(tally.lastCoingeckoHeaders!["x-cg-pro-api-key"]).toBeUndefined();
  });

  it("COINGECKO_API_KEY (legacy alias) → public base + x-cg-demo-api-key header", async () => {
    process.env.COINGECKO_API_KEY = "legacy-key-xyz";
    const tally = installFetchRouter({ coingecko: { [METH]: 2500 } });

    await getTokenPrices({
      tokens: ["cmETH"],
      base_currency: "usd",
      network: "mainnet"
    });

    expect(tally.lastCoingeckoUrl!).toContain("api.coingecko.com");
    expect(tally.lastCoingeckoHeaders!["x-cg-demo-api-key"]).toBe("legacy-key-xyz");
  });

  it("COINGECKO_PRO_API_KEY → Pro base + x-cg-pro-api-key header, wins over demo", async () => {
    process.env.COINGECKO_PRO_API_KEY = "pro-key-123";
    process.env.COINGECKO_DEMO_API_KEY = "demo-key-should-be-ignored";
    const tally = installFetchRouter({ coingecko: { [METH]: 2500 } });

    await getTokenPrices({
      tokens: ["cmETH"],
      base_currency: "usd",
      network: "mainnet"
    });

    expect(tally.lastCoingeckoUrl!).toContain("pro-api.coingecko.com");
    expect(tally.lastCoingeckoHeaders!["x-cg-pro-api-key"]).toBe("pro-key-123");
    expect(tally.lastCoingeckoHeaders!["x-cg-demo-api-key"]).toBeUndefined();
  });

  it("free tier (no key) issues one CoinGecko request per address — NOT a batched request", async () => {
    // The free public API rejects batches with HTTP 400 (error_code 10012).
    // Our code must fall back to one request per address.
    const tally = installFetchRouter({ coingecko: { [METH]: 2500, [USDC]: 1.0 } });

    await getTokenPrices({
      tokens: ["cmETH", "USDC"],
      base_currency: "usd",
      network: "mainnet"
    });

    // 2 tokens → 2 separate CoinGecko HTTP calls (NOT 1 batched call).
    expect(tally.coingecko).toBe(2);
  });

  it("Demo tier batches all addresses into a single request", async () => {
    process.env.COINGECKO_DEMO_API_KEY = "demo-key-abc";
    const tally = installFetchRouter({ coingecko: { [METH]: 2500, [USDC]: 1.0 } });

    await getTokenPrices({
      tokens: ["cmETH", "USDC"],
      base_currency: "usd",
      network: "mainnet"
    });

    // Demo can batch → 1 combined request with both addresses.
    expect(tally.coingecko).toBe(1);
    expect(tally.lastCoingeckoUrl!).toContain(METH);
    expect(tally.lastCoingeckoUrl!).toContain(USDC);
  });

  it("Pro tier batches all addresses into a single request", async () => {
    process.env.COINGECKO_PRO_API_KEY = "pro-key-123";
    const tally = installFetchRouter({ coingecko: { [METH]: 2500, [USDC]: 1.0 } });

    await getTokenPrices({
      tokens: ["cmETH", "USDC"],
      base_currency: "usd",
      network: "mainnet"
    });

    expect(tally.coingecko).toBe(1);
    expect(tally.lastCoingeckoUrl!).toContain("pro-api.coingecko.com");
  });
});

describe("token.ts — MNT base currency confidence compounding", () => {
  it("compounds to the lower confidence when MNT/USD is weak", async () => {
    // cmETH: 3 sources agree → high confidence
    // WMNT: only DefiLlama → low confidence
    // Result confidence for cmETH quoted in MNT must be "low" (the weaker side).
    installFetchRouter({
      coingecko: { [METH]: 2500 },
      dexscreener: {
        [METH]: [dsPair(METH, 2500, 10_000_000)]
        // WMNT absent → DexScreener returns no pairs
      },
      defillama: { [METH]: 2500, [WMNT]: 1.0 }
    });

    const p = (await getTokenPrices({
      tokens: ["cmETH"],
      base_currency: "mnt",
      network: "mainnet"
    })).prices[0];

    expect(p.price).toBe(2500); // 2500 USD / 1 USD-per-MNT
    expect(p.confidence).toBe("low"); // lower of high (cmETH) and low (MNT)
  });

  it("prefixes MNT-side warnings with 'MNT: ' when quoting in MNT", async () => {
    installFetchRouter({
      coingecko: { [METH]: 2500, [WMNT]: 1.0 },
      dexscreener: {
        [METH]: [dsPair(METH, 2500, 10_000_000)],
        [WMNT]: [dsPair(WMNT, 1.5, 10_000_000)] // 50% diverge — forces MNT low-confidence warning
      },
      defillama: { [METH]: 2500, [WMNT]: 1.0 }
    });

    const p = (await getTokenPrices({
      tokens: ["cmETH"],
      base_currency: "mnt",
      network: "mainnet"
    })).prices[0];

    const mntWarnings = p.warnings.filter((w: string) => w.startsWith("MNT: "));
    expect(mntWarnings.length).toBeGreaterThan(0);
    expect(mntWarnings[0]).toMatch(/^MNT: .*diverge/i);
  });
});

/* ====================================================================== */
/*  defi-write.ts — __testFetchTokenPriceUsd (LP deposit price oracle)       */
/* ====================================================================== */

describe("defi-write.ts fetchTokenPriceUsd — 3-source cross-validated price", () => {
  // Silence the intentional console.warn emissions when divergence is
  // detected; tests assert on behaviour, not log content.
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("returns CoinGecko's value when sources agree", async () => {
    installFetchRouter({
      coingecko: { [USDC]: 1.0 },
      dexscreener: { [USDC]: [dsPair(USDC, 1.001, 5_000_000)] },
      defillama: { [USDC]: 0.999 }
    });

    const price = await fetchTokenPriceUsd("mainnet", USDC);
    expect(price).toBe(1.0);
  });

  it("returns the DS/DL average when CoinGecko is down and they disagree", async () => {
    installFetchRouter({
      coingecko: {},
      dexscreener: { [USDC]: [dsPair(USDC, 0.9, 5_000_000)] },
      defillama: { [USDC]: 1.1 }
    });

    const price = await fetchTokenPriceUsd("mainnet", USDC);
    expect(price).toBe(1.0); // (0.9 + 1.1) / 2
  });

  it("returns null when every source is unreachable", async () => {
    installFetchRouter({ coingecko: {}, dexscreener: {}, defillama: {} });

    const price = await fetchTokenPriceUsd("mainnet", USDC);
    expect(price).toBeNull();
  });

  it("returns null off mainnet without making any HTTP calls", async () => {
    const tally = installFetchRouter({ coingecko: { [USDC]: 1.0 } });
    const price = await fetchTokenPriceUsd("sepolia", USDC);
    expect(price).toBeNull();
    expect(tally.coingecko).toBe(0);
    expect(tally.dexscreener).toBe(0);
    expect(tally.defillama).toBe(0);
  });

  it("queries all three sources in parallel on mainnet", async () => {
    const tally = installFetchRouter({
      coingecko: { [USDC]: 1.0 },
      dexscreener: { [USDC]: [dsPair(USDC, 1.0, 5_000_000)] },
      defillama: { [USDC]: 1.0 }
    });

    await fetchTokenPriceUsd("mainnet", USDC);

    expect(tally.coingecko).toBe(1);
    expect(tally.dexscreener).toBe(1);
    expect(tally.defillama).toBe(1);
  });

  it("logs a warning on significant divergence but still returns CoinGecko's price", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installFetchRouter({
      coingecko: { [USDC]: 1.0 },
      dexscreener: { [USDC]: [dsPair(USDC, 2.0, 5_000_000)] }, // 100% off
      defillama: { [USDC]: 1.0 }
    });

    const price = await fetchTokenPriceUsd("mainnet", USDC);
    expect(price).toBe(1.0);
    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/divergence/i);
  });
});
