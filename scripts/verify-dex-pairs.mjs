#!/usr/bin/env node
/**
 * verify-dex-pairs.mjs
 *
 * 验证 packages/core/src/config/dex-pairs.ts 中每条 DEX pair 记录与
 * Mantle 主网链上数据是否一致：
 *
 *   1. token 地址 → ERC20.symbol() 链上 symbol 与 dex-pairs.ts TOKENS / XSTOCKS
 *      中声明的 key 名一致（大小写不敏感，特殊别名见 SYMBOL_ALIASES）。
 *   2. pool token 组成：
 *        - merchant_moe (LB v2): pool.getTokenX() / getTokenY()
 *        - agni / fluxion (V3) : pool.token0()    / token1()
 *      链上返回的两个地址必须等于 pair.tokenAAddress / tokenBAddress（顺序无关）。
 *   3. 池参数：
 *        - merchant_moe (LB v2): pool.getBinStep()  与 binStep 一致
 *        - agni / fluxion (V3) : pool.fee()         与 feeTier 一致
 *   4. EIP-55 checksum：tokenAAddress / tokenBAddress / pool 三个地址的大小写
 *      （仅警告，不影响功能；--fix 选项暂未实现，因为 dex-pairs.ts 是 TS
 *      源码，自动改写源码风险较高，留给人工修复）。
 *
 * 用法:
 *   MANTLE_RPC_URL=https://your-rpc node scripts/verify-dex-pairs.mjs
 *   node scripts/verify-dex-pairs.mjs                       # 用默认公共 RPC
 *
 * 退出码:
 *   0 — 无真实数据错误（checksum 警告不算）
 *   1 — 有真实数据错误
 *
 * 实现细节:
 *   - 通过 dynamic import 加载 packages/core/dist/config/dex-pairs.js，
 *     确保校验的就是 TS 源码本身（避免脚本与源数据漂移）。
 *   - 如果 dist 缺失或过期（早于 src 的 mtime），脚本会自动跑一次
 *     `npm run build -w packages/core`，再继续。
 */

import {
  createPublicClient,
  http,
  fallback,
  defineChain,
  getAddress,
  isAddress,
} from "viem";
import { existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

// ── 路径 ─────────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SRC_PATH = join(REPO_ROOT, "packages/core/src/config/dex-pairs.ts");
const DIST_PATH = join(REPO_ROOT, "packages/core/dist/config/dex-pairs.js");

// ── 终端配色 ─────────────────────────────────────────────────────────────────
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const log = (m) => console.log(m);
const ok = (m) => console.log(`  ${GREEN}✓${RESET} ${m}`);
const fail = (m) => console.log(`  ${RED}✗${RESET} ${m}`);
const warn = (m) => console.log(`  ${YELLOW}⚠${RESET} ${m}`);

// ── 链上 symbol 与 dex-pairs.ts key 名的允许别名 ─────────────────────────────
//
// dex-pairs.ts 里 TOKENS 的 key 名是给“路由层”用的逻辑符号，不一定与链上
// ERC20.symbol() 完全相同。下面映射记录所有“已知合理差异”。任何不在表
// 内的 mismatch 都会被当作真实错误。
const SYMBOL_ALIASES = {
  // 逻辑符号 → 允许的链上 symbol 集合（小写）
  WMNT: ["wmnt", "mnt"],
  WETH: ["weth", "eth"],
  USDC: ["usdc"],
  USDT: ["usdt"],
  USDT0: ["usdt0", "usd₮0", "usdt", "usdt.e", "lz_usdt"], // LayerZero OFT 在不同部署下命名差异较大
  USDe: ["usde"],
  cmETH: ["cmeth"],
  FBTC: ["fbtc"],
  MOE: ["moe"],
  BSB: ["bsb"],
  ELSA: ["elsa"],
  VOOI: ["vooi"],
  SCOR: ["scor"],
  // 包装版 xStocks
  wMETAx: ["wmetax", "metax"],
  wTSLAx: ["wtslax", "tslax"],
  wGOOGLx: ["wgooglx", "googlx"],
  wNVDAx: ["wnvdax", "nvdax"],
  wQQQx: ["wqqqx", "qqqx"],
  wAAPLx: ["waaplx", "aaplx"],
  wSPYx: ["wspyx", "spyx"],
  wMSTRx: ["wmstrx", "mstrx"],
};

function isAllowedSymbol(logicalKey, chainSymbol) {
  if (!chainSymbol) return false;
  const want = chainSymbol.trim().toLowerCase();
  const aliases = SYMBOL_ALIASES[logicalKey];
  if (aliases) return aliases.includes(want);
  // 兜底：去掉前导 W 后比较
  return (
    want === logicalKey.toLowerCase() ||
    want === logicalKey.toLowerCase().replace(/^w/, "")
  );
}

// ── 加载 dex-pairs.ts（通过编译产物 dist 动态 import）────────────────────────
async function loadPairs() {
  const srcMtime = statSync(SRC_PATH).mtimeMs;
  const distFresh =
    existsSync(DIST_PATH) && statSync(DIST_PATH).mtimeMs >= srcMtime;

  if (!distFresh) {
    log(
      `${DIM}dist 缺失或落后于 src，正在构建 packages/core...${RESET}`
    );
    execSync("npm run build -w packages/core", {
      stdio: "inherit",
      cwd: REPO_ROOT,
    });
  }

  const mod = await import(pathToFileURL(DIST_PATH).href);
  if (typeof mod.listAllPairs !== "function" || !mod.TOKENS || !mod.XSTOCKS) {
    throw new Error(
      "dex-pairs dist 缺少 listAllPairs / TOKENS / XSTOCKS 导出"
    );
  }
  return {
    pairs: mod.listAllPairs(),
    tokens: mod.TOKENS,
    xstocks: mod.XSTOCKS,
  };
}

// ── Mantle 主网客户端 ────────────────────────────────────────────────────────
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

const transports = RPC_URLS.map((u) =>
  http(u, { retryCount: 3, timeout: 20_000 })
);
const client = createPublicClient({
  chain: mantleMainnet,
  transport:
    transports.length > 1
      ? fallback(transports, { retryCount: 0 })
      : transports[0],
});

// ── ABI 片段 ─────────────────────────────────────────────────────────────────
const ERC20_ABI = [
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
];

const V3_POOL_ABI = [
  {
    name: "token0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "token1",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "fee",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint24" }],
  },
];

const LB_V2_POOL_ABI = [
  {
    name: "getTokenX",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "getTokenY",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "getBinStep",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint16" }],
  },
];

// ── 辅助 ─────────────────────────────────────────────────────────────────────
const cs = (addr) => {
  try {
    return getAddress(addr);
  } catch {
    return null;
  }
};
const lc = (a) => (a ?? "").toLowerCase();
const eq = (a, b) => lc(a) === lc(b);

const isLB = (p) => p.provider === "merchant_moe" && p.poolType !== "v1";
const isMoeV1 = (p) => p.provider === "merchant_moe" && p.poolType === "v1";

// ── 主逻辑 ───────────────────────────────────────────────────────────────────
async function main() {
  log(`\n${BOLD}${CYAN}═══ dex-pairs.ts 链上验证脚本 ═══${RESET}`);
  log(`RPC : ${RPC_URLS[0]}${RPC_URLS.length > 1 ? `  ${DIM}(+${RPC_URLS.length - 1} fallback)${RESET}` : ""}`);

  const { pairs, tokens, xstocks } = await loadPairs();

  log(`Pair: ${BOLD}${pairs.length}${RESET} 条`);
  log(
    `Token: ${BOLD}${Object.keys(tokens).length}${RESET} (TOKENS) + ${BOLD}${Object.keys(xstocks).length}${RESET} (XSTOCKS)\n`
  );

  // ──────────────────────────────────────────────────────────────────────────
  // 反查表：逻辑符号 → 期望地址，地址（小写）→ 逻辑符号
  // ──────────────────────────────────────────────────────────────────────────
  const allLogical = { ...tokens, ...xstocks };
  /** 小写地址 → 逻辑 key */
  const addrToLogical = {};
  for (const [k, v] of Object.entries(allLogical)) {
    addrToLogical[v.toLowerCase()] = k;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // [1/4] 校验 pair 中 tokenA/B 名称与 tokenA/BAddress 是否对应 TOKENS 表
  // ──────────────────────────────────────────────────────────────────────────
  log(`${BOLD}[1/4] 校验 pair tokenA/B ↔ TOKENS 表${RESET}`);
  const localErrors = [];
  for (const [idx, p] of pairs.entries()) {
    for (const side of ["A", "B"]) {
      const sym = p[`token${side}`];
      const addr = p[`token${side}Address`];
      const expected = allLogical[sym];
      if (!expected) {
        localErrors.push({
          idx,
          msg: `pair[${idx}] (${p.provider} ${p.tokenA}/${p.tokenB}): 未知 token symbol "${sym}" — 不在 TOKENS / XSTOCKS 表内`,
        });
      } else if (!eq(expected, addr)) {
        localErrors.push({
          idx,
          msg: `pair[${idx}] (${p.provider} ${p.tokenA}/${p.tokenB}): token${side}Address 与 TOKENS["${sym}"] 不一致 — pair=${addr} TOKENS=${expected}`,
        });
      }
    }
  }
  if (localErrors.length === 0) {
    ok(`所有 pair 的 tokenA/B 与 TOKENS / XSTOCKS 表完全一致`);
  } else {
    for (const e of localErrors) fail(e.msg);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // [2/4] 收集唯一 token 地址，multicall 查 symbol
  // ──────────────────────────────────────────────────────────────────────────
  const allTokenAddrs = [
    ...new Set(
      pairs.flatMap((p) => [
        p.tokenAAddress.toLowerCase(),
        p.tokenBAddress.toLowerCase(),
      ])
    ),
  ];

  log(
    `\n${BOLD}[2/4] 链上查询 ERC20.symbol() (${allTokenAddrs.length} 个 token)...${RESET}`
  );

  // 注意：viem 在打包 multicall 之前会对每个 address 跑 strict EIP-55 校验，
  // 任何一个大小写不对的地址都会让整个批次 throw（allowFailure: true 拦不住）。
  // 这里统一 lowercase 后再传给 viem —— viem 接受 lowercase（视为 raw bytes，
  // 不再做 checksum 校验），既不影响链上调用，也避免 cosmetic 问题挡掉真实校验。
  const symbolResults = await client.multicall({
    contracts: allTokenAddrs.map((addr) => ({
      address: addr.toLowerCase(),
      abi: ERC20_ABI,
      functionName: "symbol",
    })),
    allowFailure: true,
  });

  /** 小写地址 → { chainSymbol | null, callFailed, failMsg? } */
  const onchainSymbol = {};
  for (let i = 0; i < allTokenAddrs.length; i++) {
    const r = symbolResults[i];
    onchainSymbol[allTokenAddrs[i]] =
      r.status === "success"
        ? { chainSymbol: r.result, callFailed: false }
        : {
            chainSymbol: null,
            callFailed: true,
            failMsg:
              r.error?.shortMessage ?? r.error?.message ?? "reverted",
          };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // [3/4] multicall 查每个 pool 的 token0/1 (或 getTokenX/Y) + fee/binStep
  // ──────────────────────────────────────────────────────────────────────────
  log(
    `\n${BOLD}[3/4] 链上查询 pool token + 池参数 (${pairs.length} 个 pool)...${RESET}`
  );

  // 同上：lowercase 池地址，绕开 viem 的 strict checksum 校验
  // For each pool we emit exactly 3 calls so the cursor stays uniform:
  //   - LB v2:    getTokenX / getTokenY / getBinStep
  //   - V3:       token0 / token1 / fee
  //   - Moe v1:   token0 / token1 / token0 (3rd is a harmless duplicate; V1
  //               pools have no fee/binStep to verify so the 3rd result is
  //               ignored downstream).
  const poolCalls = pairs.flatMap((p) => {
    const pool = p.pool.toLowerCase();
    if (isLB(p)) {
      return [
        { address: pool, abi: LB_V2_POOL_ABI, functionName: "getTokenX" },
        { address: pool, abi: LB_V2_POOL_ABI, functionName: "getTokenY" },
        { address: pool, abi: LB_V2_POOL_ABI, functionName: "getBinStep" },
      ];
    }
    if (isMoeV1(p)) {
      return [
        { address: pool, abi: V3_POOL_ABI, functionName: "token0" },
        { address: pool, abi: V3_POOL_ABI, functionName: "token1" },
        { address: pool, abi: V3_POOL_ABI, functionName: "token0" }, // pad
      ];
    }
    return [
      { address: pool, abi: V3_POOL_ABI, functionName: "token0" },
      { address: pool, abi: V3_POOL_ABI, functionName: "token1" },
      { address: pool, abi: V3_POOL_ABI, functionName: "fee" },
    ];
  });
  const poolResults = await client.multicall({
    contracts: poolCalls,
    allowFailure: true,
  });

  // ──────────────────────────────────────────────────────────────────────────
  // [4/4] 逐条对比
  // ──────────────────────────────────────────────────────────────────────────
  log(`\n${BOLD}[4/4] 核对结果${RESET}`);
  log("─".repeat(76));

  let okCount = 0;
  let warnCount = 0;
  let errCount = localErrors.length;
  const errors = [...localErrors];
  const warns = [];

  for (let idx = 0; idx < pairs.length; idx++) {
    const p = pairs[idx];

    log(
      `\n${BOLD}[${idx + 1}/${pairs.length}] ${p.provider} | ${p.tokenA}/${p.tokenB}${RESET}`
    );
    log(`  ${DIM}${p.pool}${RESET}`);

    // (a) EIP-55 checksum 检查
    const addrFields = [
      { label: "pool", addr: p.pool },
      { label: p.tokenA, addr: p.tokenAAddress },
      { label: p.tokenB, addr: p.tokenBAddress },
    ];
    for (const { label, addr } of addrFields) {
      const correct = cs(addr);
      if (!isAddress(addr, { strict: false })) {
        fail(`${label} 地址格式无效: ${addr}`);
        errors.push({ idx, msg: `pair[${idx}] ${label} 地址无效: ${addr}` });
        errCount++;
      } else if (correct && correct !== addr) {
        warn(
          `${label} checksum 大小写不符 (${DIM}无功能影响${RESET}): ${addr} → ${CYAN}${correct}${RESET}`
        );
        warns.push({
          idx,
          msg: `pair[${idx}] ${label} checksum: ${addr} → ${correct}`,
        });
        warnCount++;
      }
    }

    // (b) 链上 symbol 校验
    for (const sym of [p.tokenA, p.tokenB]) {
      const addr = sym === p.tokenA ? p.tokenAAddress : p.tokenBAddress;
      const { chainSymbol, callFailed, failMsg } =
        onchainSymbol[addr.toLowerCase()];
      if (callFailed) {
        fail(
          `${sym} symbol() 调用失败 — 地址可能根本不是 ERC20: ${addr}  ${DIM}(${failMsg})${RESET}`
        );
        errors.push({
          idx,
          msg: `pair[${idx}] ${sym} symbol() 失败: ${addr} (${failMsg})`,
        });
        errCount++;
      } else if (!isAllowedSymbol(sym, chainSymbol)) {
        fail(
          `${sym} symbol 不符 — JSON="${sym}" 链上="${chainSymbol}"  (如确属同一资产，请补 SYMBOL_ALIASES)`
        );
        errors.push({
          idx,
          msg: `pair[${idx}] ${sym} symbol mismatch: 链上="${chainSymbol}"`,
        });
        errCount++;
      } else {
        ok(`symbol ${sym} (${DIM}链上="${chainSymbol}"${RESET})`);
        okCount++;
      }
    }

    // (c) pool token 地址 + 池参数
    const off = idx * 3;
    const rA = poolResults[off];
    const rB = poolResults[off + 1];
    const rP = poolResults[off + 2];

    if (rA.status !== "success" || rB.status !== "success") {
      const msg =
        rA.status !== "success"
          ? rA.error?.shortMessage ?? rA.error?.message
          : rB.error?.shortMessage ?? rB.error?.message;
      fail(`pool token 查询失败 — ${msg ?? "reverted"}`);
      errors.push({ idx, msg: `pair[${idx}] pool token 查询失败: ${msg}` });
      errCount++;
    } else {
      const chainA = rA.result.toLowerCase();
      const chainB = rB.result.toLowerCase();
      const jsonA = p.tokenAAddress.toLowerCase();
      const jsonB = p.tokenBAddress.toLowerCase();
      const matched =
        [jsonA, jsonB].includes(chainA) && [jsonA, jsonB].includes(chainB);

      if (!matched) {
        fail(`pool token 不匹配 ${RED}← 真实地址错误！${RESET}`);
        fail(`  链上: ${rA.result}`);
        fail(`        ${rB.result}`);
        fail(`  pair: A=${p.tokenAAddress}`);
        fail(`        B=${p.tokenBAddress}`);

        const chainSet = new Set([chainA, chainB]);
        for (const [sym, addr] of [
          [p.tokenA, p.tokenAAddress],
          [p.tokenB, p.tokenBAddress],
        ]) {
          if (!chainSet.has(addr.toLowerCase())) {
            fail(
              `  → ${YELLOW}${sym} 地址在该 pool 中不存在: ${addr}${RESET}`
            );
            const actual =
              chainSet.has(jsonA) && !chainSet.has(jsonB)
                ? chainSet.has(chainA)
                  ? rB.result
                  : rA.result
                : chainSet.has(chainA)
                  ? rA.result
                  : rB.result;
            const logicalGuess = addrToLogical[actual?.toLowerCase()];
            fail(
              `    pool 中的另一个地址: ${actual}${logicalGuess ? `  → 看起来是 ${BOLD}${logicalGuess}${RESET}` : ""}`
            );
          }
        }

        errors.push({
          idx,
          msg: `pair[${idx}] pool token 不匹配: 链上=[${rA.result}, ${rB.result}] pair=[${p.tokenAAddress}, ${p.tokenBAddress}]`,
        });
        errCount++;
      } else {
        const note = eq(chainA, jsonA)
          ? isLB(p)
            ? "A=tokenX, B=tokenY"
            : "A=token0, B=token1"
          : isLB(p)
            ? "A=tokenY, B=tokenX"
            : "A=token1, B=token0";
        ok(`pool token 地址吻合 (${DIM}${note}${RESET})`);
        okCount++;
      }
    }

    // (d) binStep / feeTier
    if (isMoeV1(p)) {
      // V1 AMM — no binStep / feeTier, skip.
      ok(`V1 AMM (${DIM}no binStep / feeTier to verify${RESET})`);
      okCount++;
    } else if (rP.status !== "success") {
      const want = isLB(p) ? "getBinStep()" : "fee()";
      const msg = rP.error?.shortMessage ?? rP.error?.message ?? "reverted";
      fail(`${want} 查询失败 — ${msg}`);
      errors.push({ idx, msg: `pair[${idx}] ${want} 失败: ${msg}` });
      errCount++;
    } else {
      const chainParam = Number(rP.result);
      if (isLB(p)) {
        if (chainParam !== p.binStep) {
          fail(
            `binStep 不符 — pair=${p.binStep} 链上=${chainParam}`
          );
          errors.push({
            idx,
            msg: `pair[${idx}] binStep mismatch: pair=${p.binStep} 链上=${chainParam}`,
          });
          errCount++;
        } else {
          ok(`binStep=${chainParam} ✓`);
          okCount++;
        }
      } else {
        if (chainParam !== p.feeTier) {
          fail(
            `feeTier 不符 — pair=${p.feeTier} 链上=${chainParam}`
          );
          errors.push({
            idx,
            msg: `pair[${idx}] feeTier mismatch: pair=${p.feeTier} 链上=${chainParam}`,
          });
          errCount++;
        } else {
          ok(`feeTier=${chainParam} ✓`);
          okCount++;
        }
      }
    }
  }

  // ── 汇总 ───────────────────────────────────────────────────────────────────
  log("\n" + "═".repeat(76));
  log(`${BOLD}验证结果汇总${RESET}`);
  log(`  ${GREEN}通过${RESET}  : ${okCount}`);
  log(
    `  ${YELLOW}警告${RESET}  : ${warnCount}  ${DIM}(checksum 大小写，纯格式问题，不影响功能)${RESET}`
  );
  log(
    `  ${RED}错误${RESET}  : ${errCount}  ${
      errCount > 0 ? RED + "← 需要修复!" + RESET : ""
    }`
  );

  if (warns.length > 0) {
    log(`\n${BOLD}${YELLOW}Checksum 警告（人工修复 dex-pairs.ts 即可）:${RESET}`);
    for (const { msg } of warns) log(`  ${YELLOW}⚠${RESET} ${msg}`);
  }

  if (errors.length > 0) {
    log(`\n${BOLD}${RED}真实数据错误 (需要人工核查并修复):${RESET}`);
    for (const { msg } of errors) log(`  ${RED}✗${RESET} ${msg}`);
  }

  if (errCount === 0 && warnCount === 0) {
    log(`\n${GREEN}${BOLD}🎉 所有 dex-pairs 数据完全正确，无任何问题！${RESET}`);
  } else if (errCount === 0) {
    log(`\n${GREEN}${BOLD}✓ 无真实数据错误${RESET}，仅有 checksum 格式警告。`);
  }

  log("");
  process.exit(errCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`${RED}未捕获错误:${RESET}`, e);
  process.exit(1);
});
