import { describe, expect, it } from "vitest";
import {
  _collectCounterpartsForSingleSide,
  _scanPairsFromSnapshot,
  defiLpReadTools
} from "@mantleio/mantle-core/tools/defi-lp-read.js";
import { MANTLE_TOKENS } from "@mantleio/mantle-core/config/tokens.js";
import { TOKENS as DEX_TOKENS, listAllPairs } from "@mantleio/mantle-core/config/dex-pairs.js";

const FBTC_ADDR = DEX_TOKENS.FBTC;

// Helper — the anchor we'll use in most tests. We skip live token resolution
// by constructing TokenInfo directly, since the unit under test doesn't need
// to resolve symbols.
const fbtcAnchor = {
  address: FBTC_ADDR,
  symbol: "FBTC",
  decimals: 8
};

describe("findPools — single-side counterpart discovery (local-only)", () => {
  it("returns counterparts synchronously with no network call (local snapshot + registries)", () => {
    // collectCounterpartsForSingleSide is now sync — no await, no fetchFn.
    const result = _collectCounterpartsForSingleSide(fbtcAnchor, "mainnet");

    // The local DexScreener snapshot has multiple FBTC pools (FBTC/cmETH,
    // FBTC/USDT, etc.). The union with listAllPairs + MANTLE_TOKENS must
    // be non-empty.
    expect(result.counterparts.length).toBeGreaterThan(0);

    // sources tells callers which inputs contributed — exactly the three
    // local sources, never "dexscreener_token_pairs_failed" or similar.
    expect(result.sources).toEqual(
      expect.arrayContaining([
        "dexscreener_pools_snapshot",
        "static_pair_registry",
        "mantle_token_registry"
      ])
    );
  });

  it("covers pools from the DexScreener snapshot where anchor is baseToken OR quoteToken", () => {
    const result = _collectCounterpartsForSingleSide(fbtcAnchor, "mainnet");
    const addrs = new Set(result.counterparts.map((c) => c.address.toLowerCase()));

    // cmETH is a known FBTC counterpart on Agni (see
    // config/dexscreener-pools.json — FBTC is baseToken, cmETH is
    // quoteToken). Must be present.
    expect(addrs.has("0xe6829d9a7ee3040e1276fa75293bde931859e8fa")).toBe(true);
  });

  it("does NOT include the anchor itself as a counterpart (even when snapshot contains self-pairs)", () => {
    const result = _collectCounterpartsForSingleSide(fbtcAnchor, "mainnet");
    const addrs = result.counterparts.map((c) => c.address.toLowerCase());
    expect(addrs).not.toContain(FBTC_ADDR.toLowerCase());
  });

  it("dedupes counterparts across all three sources by lowercased address", () => {
    const result = _collectCounterpartsForSingleSide(fbtcAnchor, "mainnet");

    const seen = new Set<string>();
    for (const c of result.counterparts) {
      const key = c.address.toLowerCase();
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("every registry token (non-native, non-anchor) ends up in counterparts as a safety net", () => {
    const result = _collectCounterpartsForSingleSide(fbtcAnchor, "mainnet");
    const addrs = new Set(result.counterparts.map((c) => c.address.toLowerCase()));

    for (const entry of Object.values(MANTLE_TOKENS.mainnet)) {
      if (entry.address === "native") continue;
      if (entry.address.toLowerCase() === FBTC_ADDR.toLowerCase()) continue;
      expect(addrs.has(entry.address.toLowerCase())).toBe(true);
    }
  });

  it("includes every listAllPairs() counterpart for the anchor", () => {
    const result = _collectCounterpartsForSingleSide(fbtcAnchor, "mainnet");
    const addrs = new Set(result.counterparts.map((c) => c.address.toLowerCase()));

    for (const pair of listAllPairs()) {
      if (pair.tokenAAddress.toLowerCase() === FBTC_ADDR.toLowerCase()) {
        expect(addrs.has(pair.tokenBAddress.toLowerCase())).toBe(true);
      } else if (pair.tokenBAddress.toLowerCase() === FBTC_ADDR.toLowerCase()) {
        expect(addrs.has(pair.tokenAAddress.toLowerCase())).toBe(true);
      }
    }
  });

  it("works on sepolia: skips the mainnet-only snapshot but still returns registry tokens", () => {
    const wmntSepolia = {
      address: "0x19f5557E23e9914A18239990f6C70D68FDF0deD5",
      symbol: "WMNT",
      decimals: 18
    };
    const result = _collectCounterpartsForSingleSide(wmntSepolia, "sepolia");

    // Sepolia snapshot is empty → "dexscreener_pools_snapshot" should NOT
    // be in sources (it only gets added when >=1 snapshot entry matched).
    expect(result.sources).not.toContain("dexscreener_pools_snapshot");

    // Registry has only MNT (native, skipped) and WMNT (anchor, skipped) on
    // sepolia → counterparts should be empty.
    expect(result.counterparts).toHaveLength(0);
  });

  it("excludes the native gas token address ('native' sentinel) from counterparts", () => {
    const result = _collectCounterpartsForSingleSide(fbtcAnchor, "mainnet");
    expect(result.counterparts.some((c) => c.address === "native")).toBe(false);
    expect(result.counterparts.some((c) => !c.address.startsWith("0x"))).toBe(false);
  });
});

describe("findPools — input validation", () => {
  const handler = defiLpReadTools.mantle_findPools.handler;

  it("throws when neither token_a nor token_b is provided", async () => {
    await expect(handler({ network: "mainnet" })).rejects.toThrow(
      /At least one of token_a or token_b is required/
    );
  });

  it("throws when token_a === token_b (pair mode must use distinct tokens)", async () => {
    await expect(
      handler({ token_a: "FBTC", token_b: "FBTC", network: "mainnet" })
    ).rejects.toThrow(/must be different tokens/);
  });

  it("accepts whitespace-only strings as 'not provided' for single-side fallback", async () => {
    // "   " should be treated as unprovided. With both unprovided, the
    // validator fires. (This pins down the trim()/length check.)
    await expect(
      handler({ token_a: "   ", token_b: "", network: "mainnet" })
    ).rejects.toThrow(/At least one of token_a or token_b is required/);
  });
});

describe("findPools — scanPairsFromSnapshot (zero-RPC pool discovery)", () => {
  const cmethAddr = "0xE6829d9a7eE3040e1276Fa75293Bde931859e8fA";
  const cmethCounterpart = { address: cmethAddr, symbol: "cmETH", decimals: 18 };

  it("returns pools synchronously with no network call (local snapshot only)", () => {
    // Pure pair-mode call: FBTC × cmETH. The DexScreener snapshot contains
    // at least one such pool (see config/dexscreener-pools.json entry 0).
    const pools = _scanPairsFromSnapshot("mainnet", fbtcAnchor, [cmethCounterpart]);
    expect(pools.length).toBeGreaterThan(0);

    for (const p of pools) {
      // token_a is always the anchor, regardless of on-chain token0/token1 ordering.
      expect(p.token_a.address.toLowerCase()).toBe(FBTC_ADDR.toLowerCase());
      expect(p.token_b.address.toLowerCase()).toBe(cmethAddr.toLowerCase());
    }
  });

  it("tags discovered pools with liquidity_unit='dexscreener_usd_snapshot'", () => {
    const pools = _scanPairsFromSnapshot("mainnet", fbtcAnchor, [cmethCounterpart]);
    expect(pools.length).toBeGreaterThan(0);
    for (const p of pools) {
      expect(p.liquidity_unit).toBe("dexscreener_usd_snapshot");
    }
  });

  it("reports liquidity_raw as an integer-string USD value (floored)", () => {
    const pools = _scanPairsFromSnapshot("mainnet", fbtcAnchor, [cmethCounterpart]);
    for (const p of pools) {
      // Must be a decimal-integer string, NOT a bigint uint128.
      expect(p.liquidity_raw).toMatch(/^\d+$/);
      // Pools from the snapshot path either have non-zero USD (has_liquidity=true)
      // or come from the static fallback (has_liquidity=true but liquidity_raw="0").
      if (p.has_liquidity && p.liquidity_raw !== "0") {
        expect(Number(p.liquidity_raw)).toBeGreaterThan(0);
      }
    }
  });

  it("dedupes pools by lowercased pool address across sources", () => {
    const pools = _scanPairsFromSnapshot("mainnet", fbtcAnchor, [cmethCounterpart]);
    const addrs = new Set<string>();
    for (const p of pools) {
      const key = p.pool_address.toLowerCase();
      expect(addrs.has(key)).toBe(false);
      addrs.add(key);
    }
  });

  it("excludes counterparts that don't pair with the anchor", () => {
    // Pass a bogus counterpart — no pool should come back because neither
    // the snapshot nor the static registry has an FBTC × 0xDEAD entry.
    const bogus = {
      address: "0x000000000000000000000000000000000000dEaD",
      symbol: "ZERO",
      decimals: 18
    };
    const pools = _scanPairsFromSnapshot("mainnet", fbtcAnchor, [bogus]);
    // Result must be strictly empty — we did NOT ask for FBTC × cmETH, so
    // the real FBTC/cmETH snapshot pool must NOT leak through.
    expect(pools.length).toBe(0);
  });

  it("returns empty for sepolia without blowing up (no snapshot, no registry pairs)", () => {
    const wmntSepolia = {
      address: "0x19f5557E23e9914A18239990f6C70D68FDF0deD5",
      symbol: "WMNT",
      decimals: 18
    };
    // On sepolia we have no snapshot and no static pair registry entries for
    // WMNT × anything, so the result is an empty array rather than a throw.
    const pools = _scanPairsFromSnapshot("sepolia", wmntSepolia, [
      { address: DEX_TOKENS.USDC, symbol: "USDC", decimals: 6 }
    ]);
    expect(Array.isArray(pools)).toBe(true);
    // At most it reports static-registry pairs, but WMNT-sepolia has none.
    expect(pools.length).toBe(0);
  });

  it("falls back to the static pair registry when the snapshot misses a known FBTC pair", () => {
    // Every (FBTC × X) pair declared in listAllPairs() must also appear in
    // the scanPairsFromSnapshot result when X is in the counterpart scope.
    const registryCounterparts = listAllPairs()
      .flatMap((p) => {
        if (p.tokenAAddress.toLowerCase() === FBTC_ADDR.toLowerCase()) {
          return [{ address: p.tokenBAddress, symbol: p.tokenB, decimals: null }];
        }
        if (p.tokenBAddress.toLowerCase() === FBTC_ADDR.toLowerCase()) {
          return [{ address: p.tokenAAddress, symbol: p.tokenA, decimals: null }];
        }
        return [];
      });
    if (registryCounterparts.length === 0) return; // nothing to assert

    const pools = _scanPairsFromSnapshot("mainnet", fbtcAnchor, registryCounterparts);
    const poolSet = new Set(pools.map((p) => p.pool_address.toLowerCase()));

    for (const pair of listAllPairs()) {
      const isFBTCPair =
        pair.tokenAAddress.toLowerCase() === FBTC_ADDR.toLowerCase() ||
        pair.tokenBAddress.toLowerCase() === FBTC_ADDR.toLowerCase();
      if (!isFBTCPair) continue;
      expect(poolSet.has(pair.pool.toLowerCase())).toBe(true);
    }
  });

  it("filters out anchor-as-counterpart defensively (no self-pair pools)", () => {
    // Pass the anchor itself as a counterpart — should be silently dropped.
    const pools = _scanPairsFromSnapshot("mainnet", fbtcAnchor, [fbtcAnchor]);
    expect(pools.length).toBe(0);
  });
});
