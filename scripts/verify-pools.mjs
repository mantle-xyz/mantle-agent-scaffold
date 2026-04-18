#!/usr/bin/env node
/**
 * verify-pools.mjs
 *
 * 验证 dexscreener-pools.json 中每条记录的准确性：
 *   1. token symbol     — 链上 ERC20.symbol() 是否与 JSON 一致
 *   2. pool token 组成  — 链上 token0/token1 (或 getTokenX/getTokenY) 是否匹配
 *   3. 地址 checksum    — EIP-55 格式校验（仅警告，不影响功能）
 *
 * 相关脚本:
 *   scripts/refresh-pools.mjs — 从 DexScreener 拉取 + 链上核验 + 重建 JSON。
 *                               本脚本则是独立的只读复核，用于日常巡检。
 *
 * 用法:
 *   node scripts/verify-pools.mjs              # 只检查，不修改
 *   node scripts/verify-pools.mjs --fix        # 检查 + 自动修复 checksum 大小写
 *   MANTLE_RPC_URL=https://xxx node scripts/verify-pools.mjs
 *
 * 退出码:
 *   0 — 无真实错误（checksum 警告不算）
 *   1 — 有真实数据错误（symbol 错误 / pool token 不匹配）
 */

import { createPublicClient, http, fallback, defineChain, getAddress, isAddress } from "viem";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// ── CLI 参数 ──────────────────────────────────────────────────────────────────
const FIX_MODE = process.argv.includes("--fix");

// ── 路径 ─────────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const JSON_PATH = join(
  __dirname,
  "../packages/core/src/config/dexscreener-pools.json"
);

// ── Mantle mainnet 客户端 ─────────────────────────────────────────────────────
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const mantleMainnet = defineChain({
  id: 5000,
  name: "Mantle",
  nativeCurrency: { name: "MNT", symbol: "MNT", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mantle.xyz/"] } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

const RPC_URLS = process.env.MANTLE_RPC_URL
  ? [process.env.MANTLE_RPC_URL]
  : [
      "https://rpc.mantle.xyz",
      "https://mantle-mainnet.public.blastapi.io",
      "https://mantle.drpc.org",
    ];

const transports = RPC_URLS.map((u) => http(u, { retryCount: 3, timeout: 20_000 }));
const client = createPublicClient({
  chain: mantleMainnet,
  transport: transports.length > 1 ? fallback(transports, { retryCount: 0 }) : transports[0],
});

// ── ABI 片段 ──────────────────────────────────────────────────────────────────
const ERC20_ABI = [
  { name: "symbol",   type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8"  }] },
];

// Uniswap V3 / agni / fluxion / merchant_moe v1
const V3_POOL_ABI = [
  { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

// Merchant Moe LB v2
const LB_POOL_ABI = [
  { name: "getTokenX", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "getTokenY", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

// ── 辅助 ──────────────────────────────────────────────────────────────────────
const cs   = (addr) => { try { return getAddress(addr); } catch { return null; } };
const eq   = (a, b) => a?.toLowerCase() === b?.toLowerCase();

const RED    = "\x1b[31m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const RESET  = "\x1b[0m";

const log  = (msg)  => console.log(msg);
const ok   = (msg)  => console.log(`  ${GREEN}✓${RESET} ${msg}`);
const fail = (msg)  => console.log(`  ${RED}✗${RESET} ${msg}`);
const warn = (msg)  => console.log(`  ${YELLOW}⚠${RESET} ${msg}`);

// ── 主逻辑 ────────────────────────────────────────────────────────────────────
async function main() {
  log(`\n${BOLD}${CYAN}═══ dexscreener-pools.json 验证脚本 ═══${RESET}`);
  log(`RPC : ${RPC_URLS[0]}`);
  log(`模式: ${FIX_MODE ? `${YELLOW}--fix (自动修复 checksum)${RESET}` : "只读验证"}\n`);

  // 深拷贝原始 JSON，--fix 时在上面做修改
  const rawText = readFileSync(JSON_PATH, "utf8");
  const config  = JSON.parse(rawText);
  const pools   = config.pools;

  log(`共 ${BOLD}${pools.length}${RESET} 个 pool 待验证\n`);

  // ────────────────────────────────────────────────────────────────────────────
  // 步骤 1：收集唯一 token 地址，multicall 查 symbol
  // ────────────────────────────────────────────────────────────────────────────
  const allTokenAddrs = [...new Set(
    pools.flatMap((p) => [p.baseToken.address.toLowerCase(), p.quoteToken.address.toLowerCase()])
  )];

  log(`${BOLD}[1/3] 查询链上 symbol (${allTokenAddrs.length} 个 token)...${RESET}`);

  const symbolResults = await client.multicall({
    contracts: allTokenAddrs.map((addr) => ({ address: addr, abi: ERC20_ABI, functionName: "symbol" })),
    allowFailure: true,
  });

  /** addr (lowercase) → { chainSymbol: string|null, callFailed: bool } */
  const onchain = {};
  for (let i = 0; i < allTokenAddrs.length; i++) {
    const r = symbolResults[i];
    onchain[allTokenAddrs[i]] = r.status === "success"
      ? { chainSymbol: r.result, callFailed: false }
      : { chainSymbol: null,     callFailed: true,
          failMsg: r.error?.shortMessage ?? r.error?.message ?? "reverted" };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 步骤 2：multicall 查 pool 内两个 token 地址
  // ────────────────────────────────────────────────────────────────────────────
  log(`\n${BOLD}[2/3] 查询链上 pool token 地址 (${pools.length} 个 pool)...${RESET}`);

  const isLBv2  = (p) => p.provider === "merchant_moe" && p.version === 2;
  const fnA     = (p) => isLBv2(p) ? "getTokenX" : "token0";
  const fnB     = (p) => isLBv2(p) ? "getTokenY" : "token1";
  const abiFor  = (p) => isLBv2(p) ? LB_POOL_ABI : V3_POOL_ABI;

  const poolResults = await client.multicall({
    contracts: pools.flatMap((p) => [
      { address: p.pool, abi: abiFor(p), functionName: fnA(p) },
      { address: p.pool, abi: abiFor(p), functionName: fnB(p) },
    ]),
    allowFailure: true,
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 步骤 3：逐条对比
  // ────────────────────────────────────────────────────────────────────────────
  log(`\n${BOLD}[3/3] 核对结果${RESET}\n`);
  log("─".repeat(72));

  let errCount  = 0;
  let warnCount = 0;
  let okCount   = 0;

  const errors  = [];   // 真实数据错误
  const warns   = [];   // 仅 checksum 大小写问题
  let   fixCount = 0;   // --fix 模式下实际修正的数量

  for (let idx = 0; idx < pools.length; idx++) {
    const p    = pools[idx];
    const pObj = config.pools[idx];   // 指向可修改的副本

    log(`\n${BOLD}[${idx + 1}/${pools.length}] ${p.provider} | ${p.baseToken.symbol}/${p.quoteToken.symbol}${RESET}`);
    log(`  ${DIM}${p.pool}${RESET}`);

    // ── (a) EIP-55 checksum 检查（警告级别，不影响功能）──────────────────────
    const addrFields = [
      { label: "pool",              get: () => p.pool,               set: (v) => { pObj.pool = v; } },
      { label: p.baseToken.symbol,  get: () => p.baseToken.address,  set: (v) => { pObj.baseToken.address  = v; } },
      { label: p.quoteToken.symbol, get: () => p.quoteToken.address, set: (v) => { pObj.quoteToken.address = v; } },
    ];

    for (const { label, get, set } of addrFields) {
      const addr    = get();
      const correct = cs(addr);
      if (!isAddress(addr, { strict: false })) {
        fail(`${label} 地址格式完全无效: ${addr}`);
        errors.push({ pool: p.pool, msg: `${label} 地址无效: ${addr}` });
        errCount++;
      } else if (correct && correct !== addr) {
        if (FIX_MODE) {
          set(correct);
          warn(`${label} checksum 已自动修正: ${addr} → ${CYAN}${correct}${RESET}`);
          fixCount++;
        } else {
          warn(`${label} checksum 大小写不符 (${DIM}无功能影响${RESET}): ${addr} → 应为 ${CYAN}${correct}${RESET}`);
        }
        warns.push({ pool: p.pool, msg: `${label} checksum: ${addr} → ${correct}` });
        warnCount++;
      }
    }

    // ── (b) token symbol 验证（真实错误）────────────────────────────────────
    for (const tok of [p.baseToken, p.quoteToken]) {
      const { chainSymbol, callFailed, failMsg } = onchain[tok.address.toLowerCase()];
      if (callFailed) {
        // symbol() 调用失败 → 该地址可能根本不是 ERC20，或地址本身就错了
        fail(`${tok.symbol} symbol() 调用失败 → 地址可能有误: ${tok.address}`);
        fail(`  原因: ${DIM}${failMsg}${RESET}`);
        errors.push({ pool: p.pool, msg: `${tok.symbol} symbol() 失败，地址疑似错误: ${tok.address}` });
        errCount++;
      } else if (chainSymbol !== tok.symbol) {
        fail(`${tok.symbol} symbol 不符 — JSON="${tok.symbol}"  链上="${chainSymbol}"`);
        errors.push({ pool: p.pool, msg: `${tok.symbol} symbol 不符: JSON=${tok.symbol} 链上=${chainSymbol}` });
        errCount++;
      } else {
        ok(`symbol ${tok.symbol}`);
        okCount++;
      }
    }

    // ── (c) pool token 地址验证（真实错误）──────────────────────────────────
    const rA = poolResults[idx * 2];
    const rB = poolResults[idx * 2 + 1];

    if (rA.status !== "success" || rB.status !== "success") {
      const msg = rA.status !== "success"
        ? (rA.error?.shortMessage ?? rA.error?.message)
        : (rB.error?.shortMessage ?? rB.error?.message);
      fail(`pool token 查询失败 — ${msg ?? "reverted"}`);
      errors.push({ pool: p.pool, msg: `pool token 查询失败: ${msg}` });
      errCount++;
    } else {
      const chainA = rA.result.toLowerCase();
      const chainB = rB.result.toLowerCase();
      const jsonA  = p.baseToken.address.toLowerCase();
      const jsonB  = p.quoteToken.address.toLowerCase();

      const matched = [jsonA, jsonB].includes(chainA) && [jsonA, jsonB].includes(chainB);

      if (!matched) {
        fail(`pool token 不匹配 ← ${RED}真实地址错误！${RESET}`);
        fail(`  链上: ${rA.result}`);
        fail(`        ${rB.result}`);
        fail(`  JSON: base=${p.baseToken.address}`);
        fail(`        quote=${p.quoteToken.address}`);

        // 尝试找出哪个 token 地址在链上根本不存在
        const chainSet = new Set([chainA, chainB]);
        for (const tok of [p.baseToken, p.quoteToken]) {
          if (!chainSet.has(tok.address.toLowerCase())) {
            fail(`  → ${YELLOW}${tok.symbol} 地址在链上不存在于此 pool: ${tok.address}${RESET}`);
            fail(`    链上实际对应地址: ${chainSet.has(jsonA) ? rB.result : rA.result}`);
          }
        }

        errors.push({
          pool: p.pool,
          msg:  `pool token 不匹配: 链上=[${rA.result}, ${rB.result}] JSON=[${p.baseToken.address}, ${p.quoteToken.address}]`
        });
        errCount++;
      } else {
        const note = eq(chainA, jsonA)
          ? "base=token0, quote=token1"
          : "base=token1, quote=token0";
        ok(`pool token 地址吻合 (${DIM}${note}${RESET})`);
        okCount++;
      }
    }
  }

  // ── --fix: 写回文件 ─────────────────────────────────────────────────────────
  if (FIX_MODE && fixCount > 0) {
    writeFileSync(JSON_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
    log(`\n${GREEN}${BOLD}已写回文件：${fixCount} 个 checksum 已自动修正${RESET}`);
  }

  // ── 汇总 ──────────────────────────────────────────────────────────────────────
  log("\n" + "═".repeat(72));
  log(`${BOLD}验证结果汇总${RESET}`);
  log(`  ${GREEN}通过${RESET}  : ${okCount}`);
  log(`  ${YELLOW}警告${RESET}  : ${warnCount}  ${DIM}(checksum 大小写，纯格式问题，不影响功能)${RESET}`);
  log(`  ${RED}错误${RESET}  : ${errCount}  ${errCount > 0 ? RED + "← 需要修复!" + RESET : ""}`);

  if (warns.length > 0 && !FIX_MODE) {
    log(`\n${BOLD}${YELLOW}Checksum 警告 (运行 --fix 可自动修正):${RESET}`);
    for (const { pool, msg } of warns) {
      log(`  ${YELLOW}⚠${RESET} ${DIM}${pool}${RESET}`);
      log(`    ${msg}`);
    }
  }

  if (errors.length > 0) {
    log(`\n${BOLD}${RED}真实数据错误 (需要人工核查并修复):${RESET}`);
    for (const { pool, msg } of errors) {
      log(`  ${RED}✗${RESET} ${pool}`);
      log(`    ${RED}${msg}${RESET}`);
    }
  }

  if (errCount === 0 && warnCount === 0) {
    log(`\n${GREEN}${BOLD}🎉 所有 pool 数据完全正确，无任何问题！${RESET}`);
  } else if (errCount === 0) {
    const fixHint = FIX_MODE ? "" : `  运行 ${CYAN}node scripts/verify-pools.mjs --fix${RESET} 可一键修正所有 checksum\n`;
    log(`\n${GREEN}${BOLD}✓ 无真实数据错误${RESET}，仅有 checksum 格式警告。`);
    if (fixHint) log(fixHint);
  }

  log("");
  process.exit(errCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`${RED}未捕获错误:${RESET}`, e);
  process.exit(1);
});
