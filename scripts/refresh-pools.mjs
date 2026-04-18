#!/usr/bin/env node
/**
 * refresh-pools.mjs
 *
 * 目的
 * ────
 *   定期（手动触发）重建 packages/core/src/config/dexscreener-pools.json。
 *   将所有 pool 查询完全搬到本地，运行时就不必再打 DexScreener，可大幅
 *   降低延迟 / 摆脱对外部 HTTP 接口的依赖。
 *
 * 流程
 * ────
 *   1. 从 DexScreener 拉取 Mantle 上的 pool 列表
 *        a. 以"种子代币"为锚点逐个调用
 *             GET /token-pairs/v1/mantle/{tokenAddr}
 *        b. 种子列表 = packages/core/src/config/registry.json 中
 *           (category=token ∧ environment=mainnet) 的全部条目 — 即 OpenClaw ×
 *           Mantle 的 token 白名单。registry 一变，下次 refresh 自动跟随。
 *        c. 所有返回结果按 pairAddress 去重做并集
 *   2. 过滤规则（OpenClaw × Mantle 白名单 + 支持的 DEX）
 *        - chainId === "mantle"
 *        - dexId ∈ { agni | merchantmoe | fluxion_factory_address }
 *        - pool 的 baseToken **和** quoteToken 地址都必须在白名单集合里
 *          （见上面的种子列表来源）。任一侧不在白名单 → 整个 pool 丢弃。
 *        - 不再设置 liquidity.usd 门槛 — 只要双侧 token 在白名单就保留，
 *          让低 TVL 的新池也能被 runtime 看到。
 *   3. 通过一条【无限制 RPC】(由 MANTLE_RPC_URL 环境变量指定) 到 Mantle
 *      主网做 multicall 链上核验：
 *        - ERC20.symbol()         → 校验 base/quote token 符号
 *        - pool.token0/token1     → 校验 V3 pool
 *        - pool.getTokenX/Y       → 校验 LB v2 pool
 *        - pool.fee()             → 确认 V3 feeTier
 *        - pool.getBinStep()      → 确认 LB v2 binStep
 *      链上读不回来或和 DexScreener 对不上的 pool 会被剔除，并给出原因。
 *   4. 与现有 JSON 合并：
 *        - 对同一 pool address，保留历史字段（如 merchant_moe 的
 *          routerVersion、poolType）。
 *        - 新发现的 merchant_moe LB v2 pool 默认写入 version=2 /
 *          routerVersion=3 （与全部历史条目一致，可在 JSON 中手动改）。
 *   5. 写回 dexscreener-pools.json
 *        - pools 按 liquidityUsd 降序排列
 *        - _meta.fetched_at 更新为今天 UTC 日期
 *        - _meta.total_pools 自动更新
 *
 * 用法
 * ────
 *   # 默认公共 RPC，仅预览（不写文件）
 *   node scripts/refresh-pools.mjs --dry-run
 *
 *   # 使用你的"无限制" RPC 做链上核验并写回文件
 *   MANTLE_RPC_URL=https://your-unlimited-rpc node scripts/refresh-pools.mjs
 *
 *   # 查看被白名单过滤器剔除的每个 pool 的原因
 *   node scripts/refresh-pools.mjs --verbose
 *
 * 代理
 * ────
 *   Node 原生 fetch 不读 HTTPS_PROXY / https_proxy 等环境变量。若你的
 *   开发机在代理后面（例如 Clash / V2Ray 的 127.0.0.1:7890），直接跑会
 *   在 TLS 阶段失败。脚本检测到任一 *_proxy 变量就会自动切到调用本机
 *   的 `curl` 来发请求 —— curl 会自动走代理。要显式禁用代理，可先
 *   `unset https_proxy HTTPS_PROXY` 再运行。
 *
 * 退出码
 * ──────
 *   0 — 成功重建（即使 DexScreener 返回的池数和上次不同）
 *   1 — 拉取 / 核验过程中出现致命错误（网络完全失败 / RPC 不可用等）
 */

import {
  createPublicClient,
  http,
  fallback,
  defineChain,
  getAddress,
  isAddress,
} from "viem";
import { readFileSync, writeFileSync, renameSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

// ─── CLI / 环境 ──────────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");

// ─── 路径 ────────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const JSON_PATH = join(
  __dirname,
  "../packages/core/src/config/dexscreener-pools.json"
);
const REGISTRY_PATH = join(
  __dirname,
  "../packages/core/src/config/registry.json"
);

// ─── 白名单 ──────────────────────────────────────────────────────────────────
// 从 canonical registry.json 读出 (category=token ∧ environment=mainnet) 的
// 所有条目，形成 token 白名单。refresh-pools.mjs 只会把 baseToken **和**
// quoteToken 同时落在这个集合里的 pool 写入 snapshot。registry 一更新，
// 下次刷新自动跟随 — 不需要也不应该在本脚本里维护重复的硬编码列表。
const REGISTRY = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
const WHITELIST_TOKENS = (REGISTRY.contracts ?? []).filter(
  (c) => c.category === "token" && c.environment === "mainnet"
);
if (WHITELIST_TOKENS.length === 0) {
  console.error(
    `registry.json (${REGISTRY_PATH}) 里没有 category=token ∧ environment=mainnet 的条目，` +
    `无法继续 — 白名单为空会把所有 pool 过滤掉。`
  );
  process.exit(1);
}
const WHITELIST_ADDRS = new Set(
  WHITELIST_TOKENS.map((t) => (t.address ?? "").toLowerCase()).filter(Boolean)
);
const WHITELIST_SYMBOL_BY_ADDR = new Map(
  WHITELIST_TOKENS.map((t) => [(t.address ?? "").toLowerCase(), t.key])
);

// ─── 颜色 ────────────────────────────────────────────────────────────────────
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const log = (m) => console.log(m);
const ok = (m) => console.log(`  ${GREEN}✓${RESET} ${m}`);
const bad = (m) => console.log(`  ${RED}✗${RESET} ${m}`);
const warn = (m) => console.log(`  ${YELLOW}⚠${RESET} ${m}`);
const dim = (m) => VERBOSE && console.log(`  ${DIM}${m}${RESET}`);

// ─── Mantle 主网客户端 ───────────────────────────────────────────────────────
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const mantleMainnet = defineChain({
  id: 5000,
  name: "Mantle",
  nativeCurrency: { name: "MNT", symbol: "MNT", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mantle.xyz/"] } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

// MANTLE_RPC_URL 视为"无限制 RPC"。未设置时回退到公共节点（会有限流，大
// 批量核验时可能触发 429，建议配置一条专用的、无限制的 RPC URL）。
const RPC_URLS = process.env.MANTLE_RPC_URL
  ? [process.env.MANTLE_RPC_URL]
  : [
      "https://rpc.mantle.xyz",
      "https://mantle-mainnet.public.blastapi.io",
      "https://mantle.drpc.org",
    ];

const transports = RPC_URLS.map((u) =>
  http(u, { retryCount: 3, timeout: 20_000, batch: true })
);
const client = createPublicClient({
  chain: mantleMainnet,
  transport: transports.length > 1 ? fallback(transports, { retryCount: 0 }) : transports[0],
});

// ─── DexScreener 常量 ────────────────────────────────────────────────────────
const DEXSCREENER_API_BASE = "https://api.dexscreener.com";
const CHAIN_ID = "mantle";

// Node 的 built-in fetch 不读 HTTPS_PROXY/https_proxy 等环境变量，若在代理
// 后面的开发机上直接跑会 TLS 握手失败。检测到任意代理变量就切到 curl —
// curl 会自动 honor 所有 *_proxy 变量且几乎所有开发机都装了。
const PROXY_ENV =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  process.env.ALL_PROXY ||
  process.env.all_proxy ||
  null;
const HTTP_MODE = PROXY_ENV ? "curl" : "native";
let firstErrorLogged = false;

// dexId → 我们内部 provider 名字（与 packages/core/src/tools/defi-lp-read.ts
// 中 dexIdToProviderName 完全一致）
function dexIdToProvider(dexId) {
  const id = (dexId ?? "").toLowerCase();
  if (id === "agni") return "agni";
  if (id === "merchantmoe") return "merchant_moe";
  if (id === "0xf883162ed9c7e8ef604214c964c678e40c9b737c") return "fluxion";
  return null;
}

// 种子代币 — 从白名单派生。每个白名单 token 都作为一次
// GET /token-pairs/v1/mantle/{addr} 查询的锚点，然后所有返回的 pair 按
// pairAddress 合并去重。因为 filterPools 要求 pool 的两侧都在白名单，所以
// 每个合格 pool 会被它自己的 base 和 quote 两次命中 — 天然冗余，任何单次
// 查询失败也不会让 pool 丢失（除非它的 base 和 quote 都没返回）。
const SEED_TOKENS = WHITELIST_TOKENS.map((t) => t.address);

// ─── ABI 片段 ────────────────────────────────────────────────────────────────
const ERC20_ABI = [
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];

const V3_POOL_ABI = [
  { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "fee", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
];

const LB_V2_POOL_ABI = [
  { name: "getTokenX", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "getTokenY", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "getBinStep", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
];

const V2_AMM_POOL_ABI = [
  { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

// ─── 工具 ────────────────────────────────────────────────────────────────────
const cs = (a) => {
  try { return getAddress(a); } catch { return null; }
};
const lc = (a) => (a ?? "").toLowerCase();
const eq = (a, b) => lc(a) === lc(b);

async function fetchJsonSafe(url, timeoutMs = 15_000) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const payload = HTTP_MODE === "curl"
        ? await fetchViaCurl(url, timeoutMs)
        : await fetchViaNative(url, timeoutMs);
      return payload;
    } catch (e) {
      lastErr = e;
      // 429 → 退避后重试；否则短暂重试一次
      const delay = e?.status === 429 ? 1500 * (attempt + 1) : 500 * (attempt + 1);
      if (attempt < 2) await new Promise((r) => setTimeout(r, delay));
    }
  }
  if (!firstErrorLogged && lastErr) {
    firstErrorLogged = true;
    warn(
      `HTTP 拉取失败样本 [${HTTP_MODE}]: ${lastErr?.code ?? lastErr?.name ?? "Error"} ` +
      `${lastErr?.message ?? ""}${lastErr?.cause ? ` / cause=${lastErr.cause.code ?? lastErr.cause.message}` : ""}`
    );
    if (HTTP_MODE === "native" && (process.env.https_proxy || process.env.HTTPS_PROXY)) {
      warn(`检测到 HTTPS_PROXY 已设置但本次走的是原生 fetch，若你的环境必须走代理，请保持 https_proxy 在当前 shell 里导出，脚本会自动切到 curl 模式。`);
    }
  }
  return null;
}

async function fetchViaNative(url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": "mantle-agent-scaffold/refresh-pools.mjs" },
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchViaCurl(url, timeoutMs) {
  const args = [
    "--silent",
    "--show-error",
    "--fail-with-body",
    "--max-time", String(Math.ceil(timeoutMs / 1000)),
    "--location",
    "-H", "User-Agent: mantle-agent-scaffold/refresh-pools.mjs",
    url,
  ];
  try {
    const { stdout } = await execFileP("curl", args, { maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (e) {
    // curl non-zero exit → 包出 HTTP 状态码 / 网络错误
    const err = new Error(e.stderr?.trim() || e.message);
    // curl --fail-with-body 把 HTTP 状态码放在 err.code 里
    if (typeof e.code === "number") err.status = e.code;
    throw err;
  }
}

// ─── 步骤 1：拉取 DexScreener 池列表 ─────────────────────────────────────────
async function fetchDexScreenerPools() {
  log(
    `\n${BOLD}[1/4] 从 DexScreener 拉取 pool 列表${RESET} ` +
    `${DIM}(${SEED_TOKENS.length} 个种子代币)${RESET}`
  );

  const byAddr = new Map(); // pairAddress (lowercase) → raw pair object

  const results = await Promise.allSettled(
    SEED_TOKENS.map(async (tokenAddr) => {
      const url = `${DEXSCREENER_API_BASE}/token-pairs/v1/${CHAIN_ID}/${tokenAddr}`;
      const payload = await fetchJsonSafe(url);
      if (!Array.isArray(payload)) return { token: tokenAddr, pairs: [], failed: true };
      return { token: tokenAddr, pairs: payload, failed: false };
    })
  );

  let failed = 0;
  let raw = 0;
  for (const r of results) {
    if (r.status !== "fulfilled" || r.value.failed) {
      failed++;
      continue;
    }
    for (const pair of r.value.pairs) {
      if (pair?.chainId !== CHAIN_ID) continue;
      const addr = lc(pair.pairAddress);
      if (!addr) continue;
      raw++;
      const existing = byAddr.get(addr);
      if (!existing) {
        byAddr.set(addr, pair);
      } else {
        // 同一 pool 被多个种子命中。DexScreener 返回的字段理论一致，偶
        // 尔 liquidity 会有细微差异，取较大者以免低估。
        const existingLiq = existing.liquidity?.usd ?? 0;
        const newLiq = pair.liquidity?.usd ?? 0;
        if (newLiq > existingLiq) byAddr.set(addr, pair);
      }
    }
  }

  if (failed > 0) {
    warn(`${failed}/${SEED_TOKENS.length} 个种子代币查询失败 (HTTP/超时)，可能遗漏少量 pool`);
  }
  ok(`收到 ${raw} 条原始记录，去重后 ${byAddr.size} 个候选 pool`);
  return [...byAddr.values()];
}

// ─── 步骤 2：按 provider + 白名单筛选 ────────────────────────────────────────
function filterPools(rawPairs) {
  log(
    `\n${BOLD}[2/4] 按规则筛选${RESET} ` +
    `${DIM}(provider ∈ {agni, merchant_moe, fluxion}，base & quote 都必须在白名单 ${WHITELIST_ADDRS.size} 个 token 内)${RESET}`
  );

  const stats = {
    wrongProvider: 0,
    nonWhitelistBase: 0,
    nonWhitelistQuote: 0,
    missingToken: 0,
    kept: 0,
  };

  const kept = [];
  for (const pair of rawPairs) {
    const provider = dexIdToProvider(pair.dexId);
    if (!provider) { stats.wrongProvider++; continue; }

    const baseAddr = pair.baseToken?.address;
    const quoteAddr = pair.quoteToken?.address;
    if (!isAddress(baseAddr, { strict: false }) || !isAddress(quoteAddr, { strict: false })) {
      stats.missingToken++;
      continue;
    }
    if (!isAddress(pair.pairAddress, { strict: false })) {
      stats.missingToken++;
      continue;
    }

    // 白名单筛选 — 两侧都必须在。OpenClaw × Mantle 的 Hard Constraint #10：
    // 任何涉及非白名单资产的 pool 都不能进入 CLI 的 approve/plan/quote 路径。
    const baseInList = WHITELIST_ADDRS.has(baseAddr.toLowerCase());
    const quoteInList = WHITELIST_ADDRS.has(quoteAddr.toLowerCase());
    if (!baseInList) {
      stats.nonWhitelistBase++;
      dim(
        `丢弃非白名单 base: ${pair.baseToken.symbol ?? "?"} (${baseAddr}) ` +
        `@ ${provider} ${pair.pairAddress}`
      );
      continue;
    }
    if (!quoteInList) {
      stats.nonWhitelistQuote++;
      dim(
        `丢弃非白名单 quote: ${pair.quoteToken.symbol ?? "?"} (${quoteAddr}) ` +
        `@ ${provider} ${pair.pairAddress}`
      );
      continue;
    }

    const liqUsd = Number(pair.liquidity?.usd ?? 0);

    kept.push({
      provider,
      pool: cs(pair.pairAddress) ?? pair.pairAddress,
      baseToken: {
        symbol: pair.baseToken.symbol ?? "?",
        address: cs(baseAddr) ?? baseAddr,
      },
      quoteToken: {
        symbol: pair.quoteToken.symbol ?? "?",
        address: cs(quoteAddr) ?? quoteAddr,
      },
      liquidityUsd: Number.isFinite(liqUsd) ? Math.round(liqUsd) : 0,
    });
    stats.kept++;
  }

  ok(`保留 ${stats.kept} 个 pool（两侧均在白名单）`);
  dim(
    `过滤掉：provider 不符=${stats.wrongProvider}，` +
    `base 不在白名单=${stats.nonWhitelistBase}，` +
    `quote 不在白名单=${stats.nonWhitelistQuote}，` +
    `地址缺失/非法=${stats.missingToken}`
  );
  return kept;
}

// ─── 步骤 3：链上 multicall 核验 ─────────────────────────────────────────────
async function verifyOnChain(candidates) {
  log(`\n${BOLD}[3/4] Mantle 主网链上核验${RESET} ${DIM}(RPC: ${RPC_URLS[0]})${RESET}`);

  // 3a: 合并所有需要查询 symbol() 的 token 地址
  const tokenAddrs = [
    ...new Set(candidates.flatMap((p) => [lc(p.baseToken.address), lc(p.quoteToken.address)])),
  ];

  log(
    `  查询 ${BOLD}${tokenAddrs.length}${RESET} 个 token symbol 和 ` +
    `${BOLD}${candidates.length}${RESET} 个 pool 的链上参数…`
  );

  // symbol() multicall
  const symbolResults = await client.multicall({
    contracts: tokenAddrs.map((addr) => ({ address: addr, abi: ERC20_ABI, functionName: "symbol" })),
    allowFailure: true,
  });
  const symbolByAddr = {};
  for (let i = 0; i < tokenAddrs.length; i++) {
    const r = symbolResults[i];
    symbolByAddr[tokenAddrs[i]] = r.status === "success" ? r.result : null;
  }

  // 3b: pool 核验 multicall
  //     每个 pool 按 provider 决定接口：
  //       merchant_moe → 首先尝试 LB v2 的 getTokenX/Y/getBinStep
  //                     失败时退化到 v1 token0/token1（老 AMM）
  //       agni, fluxion → V3: token0/token1/fee
  const poolCalls = [];
  for (const p of candidates) {
    if (p.provider === "merchant_moe") {
      poolCalls.push(
        { address: p.pool, abi: LB_V2_POOL_ABI, functionName: "getTokenX" },
        { address: p.pool, abi: LB_V2_POOL_ABI, functionName: "getTokenY" },
        { address: p.pool, abi: LB_V2_POOL_ABI, functionName: "getBinStep" },
        // 兜底：兼容 merchant_moe v1 (Uniswap V2 式)
        { address: p.pool, abi: V2_AMM_POOL_ABI, functionName: "token0" },
        { address: p.pool, abi: V2_AMM_POOL_ABI, functionName: "token1" }
      );
    } else {
      // agni / fluxion = V3
      poolCalls.push(
        { address: p.pool, abi: V3_POOL_ABI, functionName: "token0" },
        { address: p.pool, abi: V3_POOL_ABI, functionName: "token1" },
        { address: p.pool, abi: V3_POOL_ABI, functionName: "fee" }
      );
    }
  }

  const poolResults = await client.multicall({ contracts: poolCalls, allowFailure: true });

  // 按 provider 逐个消费 poolResults，相应地构造 verified pool 对象
  const verified = [];
  const dropped = [];
  let cursor = 0;
  for (const p of candidates) {
    const jsonBaseLc = lc(p.baseToken.address);
    const jsonQuoteLc = lc(p.quoteToken.address);

    // (a) 链上 symbol 校验
    const chainBaseSymbol = symbolByAddr[jsonBaseLc];
    const chainQuoteSymbol = symbolByAddr[jsonQuoteLc];
    if (chainBaseSymbol == null) {
      dropped.push({ pool: p.pool, reason: `base token ${p.baseToken.symbol} 链上 symbol() 失败 (${p.baseToken.address})` });
    }
    if (chainQuoteSymbol == null) {
      dropped.push({ pool: p.pool, reason: `quote token ${p.quoteToken.symbol} 链上 symbol() 失败 (${p.quoteToken.address})` });
    }
    // Symbol read 失败即视为链上核验未通过 — 必须推进 cursor 后跳过，否则
    // pool 会带着未经链上校验的 DexScreener symbol 进入 snapshot。
    if (chainBaseSymbol == null || chainQuoteSymbol == null) {
      cursor += p.provider === "merchant_moe" ? 5 : 3;
      continue;
    }

    let entry = null;

    if (p.provider === "merchant_moe") {
      const rTokenX = poolResults[cursor];
      const rTokenY = poolResults[cursor + 1];
      const rBinStep = poolResults[cursor + 2];
      const rV1Token0 = poolResults[cursor + 3];
      const rV1Token1 = poolResults[cursor + 4];
      cursor += 5;

      const lbOk = rTokenX.status === "success" && rTokenY.status === "success" && rBinStep.status === "success";
      const v1Ok = rV1Token0.status === "success" && rV1Token1.status === "success";

      if (lbOk) {
        // LB v2
        const x = lc(rTokenX.result);
        const y = lc(rTokenY.result);
        const match = [jsonBaseLc, jsonQuoteLc].includes(x) && [jsonBaseLc, jsonQuoteLc].includes(y);
        if (!match) {
          dropped.push({ pool: p.pool, reason: `LB v2 tokens 不匹配 链上=[${rTokenX.result},${rTokenY.result}]` });
        } else {
          entry = {
            provider: "merchant_moe",
            pool: p.pool,
            baseToken: {
              symbol: chainBaseSymbol ?? p.baseToken.symbol,
              address: cs(p.baseToken.address) ?? p.baseToken.address,
            },
            quoteToken: {
              symbol: chainQuoteSymbol ?? p.quoteToken.symbol,
              address: cs(p.quoteToken.address) ?? p.quoteToken.address,
            },
            binStep: Number(rBinStep.result),
            version: 2,
            // routerVersion 无法从 pool 上读出（由 LBRouter 决定），默认 3
            // = LB Router v2.2；若实际使用旧 router 可在 JSON 里手动改。
            routerVersion: 3,
            liquidityUsd: p.liquidityUsd,
          };
        }
      } else if (v1Ok) {
        // classic V2 AMM (merchant_moe v1)
        const t0 = lc(rV1Token0.result);
        const t1 = lc(rV1Token1.result);
        const match = [jsonBaseLc, jsonQuoteLc].includes(t0) && [jsonBaseLc, jsonQuoteLc].includes(t1);
        if (!match) {
          dropped.push({ pool: p.pool, reason: `v1 AMM tokens 不匹配 链上=[${rV1Token0.result},${rV1Token1.result}]` });
        } else {
          entry = {
            provider: "merchant_moe",
            pool: p.pool,
            baseToken: {
              symbol: chainBaseSymbol ?? p.baseToken.symbol,
              address: cs(p.baseToken.address) ?? p.baseToken.address,
            },
            quoteToken: {
              symbol: chainQuoteSymbol ?? p.quoteToken.symbol,
              address: cs(p.quoteToken.address) ?? p.quoteToken.address,
            },
            poolType: "v1",
            liquidityUsd: p.liquidityUsd,
          };
        }
      } else {
        dropped.push({
          pool: p.pool,
          reason: `merchant_moe pool 既非 LB v2 也非 v1 AMM (LB 错=${rTokenX.error?.shortMessage ?? rTokenX.status}, v1 错=${rV1Token0.error?.shortMessage ?? rV1Token0.status})`,
        });
      }
    } else {
      // V3 (agni / fluxion)
      const rT0 = poolResults[cursor];
      const rT1 = poolResults[cursor + 1];
      const rFee = poolResults[cursor + 2];
      cursor += 3;

      const allOk = rT0.status === "success" && rT1.status === "success" && rFee.status === "success";
      if (!allOk) {
        dropped.push({
          pool: p.pool,
          reason: `${p.provider} V3 read 失败 (token0=${rT0.status}, token1=${rT1.status}, fee=${rFee.status})`,
        });
      } else {
        const t0 = lc(rT0.result);
        const t1 = lc(rT1.result);
        const match = [jsonBaseLc, jsonQuoteLc].includes(t0) && [jsonBaseLc, jsonQuoteLc].includes(t1);
        if (!match) {
          dropped.push({ pool: p.pool, reason: `${p.provider} V3 tokens 不匹配 链上=[${rT0.result},${rT1.result}]` });
        } else {
          entry = {
            provider: p.provider,
            pool: p.pool,
            baseToken: {
              symbol: chainBaseSymbol ?? p.baseToken.symbol,
              address: cs(p.baseToken.address) ?? p.baseToken.address,
            },
            quoteToken: {
              symbol: chainQuoteSymbol ?? p.quoteToken.symbol,
              address: cs(p.quoteToken.address) ?? p.quoteToken.address,
            },
            feeTier: Number(rFee.result),
            liquidityUsd: p.liquidityUsd,
          };
        }
      }
    }

    if (entry) {
      // symbol 不一致只是警告 — DexScreener 可能缓存过老 symbol
      if (chainBaseSymbol && entry.baseToken.symbol !== chainBaseSymbol) {
        warn(`pool ${p.pool} base symbol 改写 ${entry.baseToken.symbol} → ${chainBaseSymbol}`);
        entry.baseToken.symbol = chainBaseSymbol;
      }
      if (chainQuoteSymbol && entry.quoteToken.symbol !== chainQuoteSymbol) {
        warn(`pool ${p.pool} quote symbol 改写 ${entry.quoteToken.symbol} → ${chainQuoteSymbol}`);
        entry.quoteToken.symbol = chainQuoteSymbol;
      }
      verified.push(entry);
    }
  }

  ok(`链上核验通过 ${verified.length} 个，剔除 ${candidates.length - verified.length} 个`);
  if (dropped.length > 0 && VERBOSE) {
    for (const d of dropped) dim(`剔除 ${d.pool}: ${d.reason}`);
  } else if (dropped.length > 0) {
    dim(`剔除明细已省略；使用 --verbose 查看`);
  }
  return { verified, dropped };
}

// ─── 步骤 4：合并历史字段 & 写回 ──────────────────────────────────────────────
function mergeAndWrite(verified, droppedCount) {
  log(`\n${BOLD}[4/4] 与既有 JSON 合并并写回${RESET}`);

  const prev = JSON.parse(readFileSync(JSON_PATH, "utf8"));
  const prevByAddr = new Map();
  for (const p of prev.pools ?? []) {
    prevByAddr.set(lc(p.pool), p);
  }

  // 保留历史的 routerVersion / poolType：若链上核验结果与历史差一格
  // （如我们默认填了 routerVersion:3，但历史为 2），以历史为准，因为
  // 历史很可能是人工修正过的。
  const merged = verified.map((v) => {
    const prior = prevByAddr.get(lc(v.pool));
    if (!prior) return v;
    const out = { ...v };
    if (v.provider === "merchant_moe") {
      if (typeof prior.routerVersion === "number") {
        out.routerVersion = prior.routerVersion;
      }
      // version 字段同理保留（默认我们已经写了 2）
      if (typeof prior.version === "number") {
        out.version = prior.version;
      }
      // v1 AMM 保留 poolType
      if (prior.poolType && !v.binStep && !out.binStep) {
        out.poolType = prior.poolType;
      }
    }
    return out;
  });

  // 按 liquidityUsd 降序排，同历史风格
  merged.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));

  const today = new Date().toISOString().slice(0, 10);
  const nextDoc = {
    _meta: {
      source: "https://dexscreener.com/mantle",
      fetched_at: today,
      filter:
        "both_tokens_whitelisted (registry.json category=token, environment=mainnet); " +
        "no liquidity threshold",
      whitelist_size: WHITELIST_ADDRS.size,
      total_pools: merged.length,
      notes:
        "Only merchant_moe, agni, fluxion pools whose base AND quote tokens " +
        "are both in the OpenClaw × Mantle whitelist (see " +
        "packages/core/src/config/registry.json). Pool parameters " +
        "(feeTier, binStep) verified on-chain via Mantle RPC. " +
        "Refreshed via scripts/refresh-pools.mjs.",
    },
    pools: merged,
  };

  const text = JSON.stringify(nextDoc, null, 2) + "\n";

  // diff 摘要
  const added = merged.filter((p) => !prevByAddr.has(lc(p.pool))).length;
  const removed = (prev.pools ?? []).filter(
    (p) => !merged.some((m) => lc(m.pool) === lc(p.pool))
  ).length;

  log("─".repeat(72));
  log(`${BOLD}变更摘要${RESET}`);
  log(`  历史 pool 数 : ${prev.pools?.length ?? 0}`);
  log(`  新   pool 数 : ${merged.length}`);
  log(`  ${GREEN}新增${RESET}         : ${added}`);
  log(`  ${RED}移除${RESET}         : ${removed}`);
  log(`  链上核验剔除 : ${droppedCount}`);

  if (DRY_RUN) {
    log(`\n${YELLOW}${BOLD}--dry-run 模式：不写入文件${RESET}`);
    log(`${DIM}预览文件大小: ${text.length} bytes${RESET}`);
    return;
  }

  // 原子写入：先写到 .tmp，再 rename 替换。这样即使脚本在写入途中被
  // Ctrl-C / OOM / 断电打断，canonical 路径上要么是完整的旧版本，要么是
  // 完整的新版本，不会出现 parse 失败的半成品 JSON 把运行时打挂。
  const tmp = `${JSON_PATH}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, JSON_PATH);
  log(`\n${GREEN}${BOLD}✓ 已写入${RESET} ${CYAN}${JSON_PATH}${RESET}`);
  log(`${DIM}建议运行 \`node scripts/verify-pools.mjs\` 做一次独立复核${RESET}`);
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────
async function main() {
  log(`\n${BOLD}${CYAN}═══ dexscreener-pools.json 刷新脚本 ═══${RESET}`);
  log(`目标文件: ${DIM}${JSON_PATH}${RESET}`);
  log(`模式    : ${DRY_RUN ? `${YELLOW}--dry-run（只预览）${RESET}` : "写入"}`);
  log(`RPC     : ${RPC_URLS[0]}${process.env.MANTLE_RPC_URL ? "" : ` ${YELLOW}(建议设置 MANTLE_RPC_URL 指向无限制 RPC)${RESET}`}`);
  log(`HTTP    : ${HTTP_MODE}${PROXY_ENV ? ` ${DIM}(detected proxy ${PROXY_ENV})${RESET}` : ""}`);
  log(`白名单  : ${WHITELIST_ADDRS.size} 个 mainnet token (from registry.json)`);

  const rawPairs = await fetchDexScreenerPools();
  if (rawPairs.length === 0) {
    bad("DexScreener 未返回任何 pool — 网络失败或接口变更，拒绝写回空列表");
    process.exit(1);
  }

  const candidates = filterPools(rawPairs);
  if (candidates.length === 0) {
    bad(
      "筛选后没有 pool — 请检查 registry.json 里的 mainnet token 是否正确" +
      "，或者 DexScreener 返回的 dexId 是否与我们支持的映射对得上"
    );
    process.exit(1);
  }

  const { verified, dropped } = await verifyOnChain(candidates);
  if (verified.length === 0) {
    bad("链上核验全部失败 — 检查 MANTLE_RPC_URL 是否可用");
    process.exit(1);
  }

  mergeAndWrite(verified, dropped.length);
  log("");
  process.exit(0);
}

main().catch((e) => {
  console.error(`${RED}未捕获错误:${RESET}`, e);
  process.exit(1);
});
