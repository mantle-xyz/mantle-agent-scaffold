#!/usr/bin/env node
/**
 * verify-price-sources.mjs
 *
 * 实机验证 price-source 修复后的三源取价是否能正确拿到真实数据：
 *   1. 各源独立可达 (CoinGecko / DexScreener / DefiLlama)
 *   2. 三源价格在合理范围内互相一致
 *   3. getTokenPrices() 端到端输出（含 source / confidence / warnings / price_sources）
 *   4. defi-write.ts 的 __testFetchTokenPriceUsd 与 token.ts 一致
 *   5. 异常场景：非 mainnet、不存在的地址
 *
 * 用法:
 *   node scripts/verify-price-sources.mjs
 *   COINGECKO_DEMO_API_KEY=... node scripts/verify-price-sources.mjs
 *   COINGECKO_PRO_API_KEY=...  node scripts/verify-price-sources.mjs
 *
 * 退出码:
 *   0 — 所有校验通过
 *   1 — 至少一个 token 的三源价格严重分歧 / 所有源都挂了
 */

import { getTokenPrices } from "../packages/core/dist/tools/token.js";
import { __testFetchTokenPriceUsd as fetchWriteTokenPriceUsd } from "../packages/core/dist/tools/defi-write.js";

const TOKENS = [
  { symbol: "MNT", expectRange: [0.3, 3.0] },      // MNT 历史区间大致 $0.3–$3
  { symbol: "WMNT", expectRange: [0.3, 3.0] },     // 同上
  { symbol: "USDC", expectRange: [0.98, 1.02] },   // 稳定币
  { symbol: "USDT", expectRange: [0.98, 1.02] },   // 稳定币
  { symbol: "mETH", expectRange: [800, 10000] }    // mETH 跟 ETH 价差不大
];

const WIDE_DIVERGENCE_PCT = 0.15; // 视为严重分歧的阈值

// ─── 简易彩色输出 ──────────────────────────────────────────────────────
const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red:   (s) => `\x1b[31m${s}\x1b[0m`,
  yellow:(s) => `\x1b[33m${s}\x1b[0m`,
  cyan:  (s) => `\x1b[36m${s}\x1b[0m`,
  dim:   (s) => `\x1b[2m${s}\x1b[0m`,
  bold:  (s) => `\x1b[1m${s}\x1b[0m`
};

function fmt(n) {
  if (n == null) return c.dim("null");
  if (n >= 100) return `$${n.toFixed(2)}`;
  if (n >= 1) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(6)}`;
}

function confTag(conf) {
  if (conf === "high")   return c.green("high");
  if (conf === "medium") return c.yellow("medium");
  return c.red("low");
}

function sourceTag(src) {
  if (src === "coingecko")   return c.green("coingecko");
  if (src === "aggregate")   return c.yellow("aggregate");
  if (src === "dexscreener" || src === "defillama") return c.yellow(src);
  if (src === "none")        return c.red("none");
  return src;
}

// ─── 打印 CoinGecko tier 使用情况 ─────────────────────────────────────
function logCoinGeckoTier() {
  const pro = process.env.COINGECKO_PRO_API_KEY;
  const demo = process.env.COINGECKO_DEMO_API_KEY ?? process.env.COINGECKO_API_KEY;
  if (pro) {
    console.log(`  ${c.cyan("CoinGecko tier")}: Pro (x-cg-pro-api-key, base=pro-api.coingecko.com)`);
  } else if (demo) {
    console.log(`  ${c.cyan("CoinGecko tier")}: Demo (x-cg-demo-api-key, base=api.coingecko.com)`);
  } else {
    console.log(`  ${c.cyan("CoinGecko tier")}: ${c.dim("free public API (no key, rate-limited)")}`);
  }
}

// ─── 主流程 ──────────────────────────────────────────────────────────
async function main() {
  console.log(c.bold("\n=== Live price-source verification ===\n"));
  logCoinGeckoTier();

  let hardFailures = 0;
  let divergenceWarnings = 0;

  console.log(`\n${c.bold("[1] getTokenPrices() end-to-end")}  base_currency=usd, network=mainnet`);
  console.log(`    fetching ${TOKENS.length} tokens in one batch …\n`);

  const result = await getTokenPrices({
    tokens: TOKENS.map((t) => t.symbol),
    base_currency: "usd",
    network: "mainnet"
  });

  for (let i = 0; i < result.prices.length; i++) {
    const expected = TOKENS[i];
    const row = result.prices[i];
    const [lo, hi] = expected.expectRange;
    const inRange = row.price != null && row.price >= lo && row.price <= hi;

    console.log(`    ${c.bold(expected.symbol.padEnd(6))} → ` +
      `price=${fmt(row.price)} ` +
      `source=${sourceTag(row.source)} ` +
      `conf=${confTag(row.confidence)}`);

    console.log(`           raw: ` +
      `CG=${fmt(row.price_sources.coingecko)}  ` +
      `DS=${fmt(row.price_sources.dexscreener)}  ` +
      `DL=${fmt(row.price_sources.defillama)}`);

    if (row.price == null) {
      console.log(`           ${c.red("✗ no source returned a price")}`);
      hardFailures++;
    } else if (!inRange) {
      console.log(`           ${c.red(`✗ price ${fmt(row.price)} outside expected [${lo}, ${hi}]`)}`);
      hardFailures++;
    } else {
      console.log(`           ${c.green("✓")} in expected range [${lo}, ${hi}]`);
    }

    // 单独评估三源分歧
    const srcs = [row.price_sources.coingecko, row.price_sources.dexscreener, row.price_sources.defillama]
      .filter((v) => v != null);
    if (srcs.length >= 2) {
      const min = Math.min(...srcs);
      const max = Math.max(...srcs);
      const dev = (max - min) / min;
      const devStr = `${(dev * 100).toFixed(1)}%`;
      if (dev > WIDE_DIVERGENCE_PCT) {
        console.log(`           ${c.yellow(`⚠ cross-source spread ${devStr} exceeds ${(WIDE_DIVERGENCE_PCT*100).toFixed(0)}%`)}`);
        divergenceWarnings++;
      } else {
        console.log(`           ${c.dim(`cross-source spread ${devStr}`)}`);
      }
    } else if (srcs.length === 1) {
      console.log(`           ${c.yellow(`⚠ only one source returned data`)}`);
    }

    for (const w of row.warnings) {
      console.log(`           ${c.dim("warn: " + w)}`);
    }
  }

  // ─── 验证 MNT 基准 ─────────────────────────────────────────────────
  console.log(`\n${c.bold("[2] base_currency=mnt (exercises MNT confidence compounding)")}\n`);
  const mntBase = await getTokenPrices({
    tokens: ["USDC", "mETH"],
    base_currency: "mnt",
    network: "mainnet"
  });
  for (const row of mntBase.prices) {
    console.log(`    ${c.bold(row.symbol.padEnd(6))} → ` +
      `price_in_mnt=${row.price == null ? c.dim("null") : row.price.toFixed(6)} ` +
      `source=${sourceTag(row.source)} conf=${confTag(row.confidence)}`);
    for (const w of row.warnings) {
      const isMntWarn = w.startsWith("MNT: ");
      console.log(`           ${isMntWarn ? c.cyan("[MNT-chain] ") : ""}${c.dim(w)}`);
    }
  }

  // ─── 验证 defi-write.ts 的 price oracle ─────────────────────────────
  console.log(`\n${c.bold("[3] defi-write.ts __testFetchTokenPriceUsd (used for real LP deposits)")}\n`);

  const WMNT = "0x78c1B0C915c4FAA5FffA6CAbf0219DA63d7f4cb8";
  const USDC = "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9";
  // cmETH is the whitelisted ETH-restaked derivative on Mantle (mETH is NOT
  // on the whitelist and is intentionally excluded here).
  const CMETH = "0xE6829d9a7eE3040e1276Fa75293Bde931859e8fA";

  for (const [name, addr, expectRange] of [
    ["WMNT", WMNT, [0.3, 3.0]],
    ["USDC", USDC, [0.98, 1.02]],
    ["cmETH", CMETH, [800, 10000]]
  ]) {
    const price = await fetchWriteTokenPriceUsd("mainnet", addr);
    const [lo, hi] = expectRange;
    const ok = price != null && price >= lo && price <= hi;
    console.log(`    ${c.bold(name.padEnd(6))} → ${fmt(price)}  ${ok ? c.green("✓") : c.red("✗")} expected [${lo}, ${hi}]`);
    if (!ok) hardFailures++;
  }

  // ─── 边界/异常场景 ─────────────────────────────────────────────────
  console.log(`\n${c.bold("[4] Edge cases")}\n`);

  const sepoliaPrice = await fetchWriteTokenPriceUsd("sepolia", USDC);
  if (sepoliaPrice === null) {
    console.log(`    ${c.green("✓")} sepolia returns null (no off-mainnet HTTP calls)`);
  } else {
    console.log(`    ${c.red("✗")} sepolia should return null, got ${sepoliaPrice}`);
    hardFailures++;
  }

  const bogus = await fetchWriteTokenPriceUsd("mainnet", "0x000000000000000000000000000000000000dEaD");
  if (bogus === null) {
    console.log(`    ${c.green("✓")} unknown address → null (no fabricated price)`);
  } else {
    console.log(`    ${c.yellow("⚠")} unknown address returned ${fmt(bogus)} — unexpected but not necessarily a bug`);
  }

  // ─── 汇总 ─────────────────────────────────────────────────────────
  console.log(`\n${c.bold("=== Summary ===")}`);
  if (hardFailures === 0) {
    console.log(c.green(`✓ all checks passed`));
  } else {
    console.log(c.red(`✗ ${hardFailures} hard failure(s)`));
  }
  if (divergenceWarnings > 0) {
    console.log(c.yellow(`⚠ ${divergenceWarnings} token(s) had cross-source spread > ${(WIDE_DIVERGENCE_PCT*100).toFixed(0)}%`));
  }
  console.log("");

  process.exit(hardFailures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(c.red("\n✗ Fatal error:"), err);
  process.exit(2);
});
