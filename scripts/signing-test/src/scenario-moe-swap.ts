/**
 * Scenario — Merchant Moe multi-version swap consistency verification.
 *
 * Merchant Moe exposes multiple swap mechanics through a single LB Router
 * (`lb_router_v2_2` at 0x013e…1E3a). The `versions[]` field inside the
 * router's path tuple selects the pool architecture per hop:
 *
 *   version 0 → "V1" (classic Uniswap-V2-style constant-product AMM —
 *                      routed through the legacy `moe_router` 0xeaEE…232a
 *                      via the LB router's V1-compat hop).
 *   version 2 → "V2.1" LB pools (rarely encountered on mainnet)
 *   version 3 → "V2.2" LB pools (the modern Liquidity Book pool set)
 *
 * From the `mantle-cli` surface we can exercise four distinct paths:
 *
 *   1.  **LB V2.2 direct** — `--bin-step <N>` on a token pair that has a
 *       direct LB pool. The factory lookup succeeds → `router_version=3`.
 *   2.  **LB V2.2 auto-routed** — no `--bin-step`. `mantle-cli` uses the
 *       on-chain LB Quoter to pick the best route (single- or multi-hop),
 *       returning binStep/versions per hop.
 *   3.  **Classic V1 AMM (forced)** — `--bin-step 0` on a pair that also
 *       has an LB pool. The factory lookup for an LB pair with binStep 0
 *       fails → `router_version=0`, and the swap flows through the MoeV1
 *       constant-product pool for that pair.
 *   4.  **Classic V1 AMM (auto-discovered)** — no `--bin-step` on a pair
 *       that has ONLY a V1 pool (e.g. MOE/WMNT). The LB Quoter inspects
 *       V1 as well and returns the V1 pool (`bin_step=0`) as the only
 *       route. This is what happens when an agent trades MOE without
 *       knowing which protocol version owns the liquidity.
 *
 * This scenario runs a roundtrip on each path via mantle-cli + local
 * signing, and asserts the full consistency contract per swap:
 *
 *   - `pool_params.router_version` / `bin_step` match the expected version.
 *   - `amount_in_raw` leaves the wallet exactly.
 *   - `amount_out >= minimum_out_raw`  (slippage honored).
 *   - `amount_out ~ estimated_out_raw` within 1 % (quote/execution parity).
 *   - No other tracked token moves (no collateral damage).
 *   - Roundtrip WMNT loss stays within the per-version fee envelope.
 *
 * Usage:
 *   TEST_PRIVATE_KEY=0x... npm run test:moe-swap         # live on mainnet
 *   TEST_PRIVATE_KEY=0x... npm run test:moe-swap:dry     # dry-run (no broadcast)
 */

import { parseEther, formatEther, formatUnits } from "viem";

import { signAndSend } from "./wallet.js";
import { buildTx, runCli } from "./cli.js";
import { test, setDetails } from "./runner.js";
import { assert, assertEqual, assertDefined, assertGreaterThan } from "./assert.js";
import {
  DRY_RUN,
  approveIfNeeded,
  readBalance,
  trackTx,
  runScenario,
  wallet,
  formatTokenAmount,
} from "./helpers.js";
import {
  WMNT,
  USDC,
  USDT,
  USDT0,
  USDe,
  MOE,
  TOKEN_DECIMALS,
  TOKEN_SYMBOL,
  MOE_LB_ROUTER,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Amounts — keep tiny so a full run costs pennies even across 4 roundtrips.
// ---------------------------------------------------------------------------
const WMNT_V22_DIRECT = "0.03";   // explicit --bin-step 25
const WMNT_V22_AUTO   = "0.03";   // no --bin-step (auto-routed)
const WMNT_V1_CLASSIC = "0.005";  // --bin-step 0 (V1 pools can be thin)
const WMNT_V1_AUTO    = "0.01";   // no --bin-step, quoter auto-picks V1 for MOE
const ENSURE_WMNT     = "0.2";    // pre-fund ≥ all four legs combined

// ---------------------------------------------------------------------------
// Consistency tolerances
// ---------------------------------------------------------------------------
/** Per-swap parity: executed `out` vs quoted `estimated_out` (1 %). */
const QUOTE_EXEC_TOLERANCE_BPS = 100n;
/** Roundtrip tolerance per version label — fee envelope + slippage buffer. */
const ROUNDTRIP_TOLERANCE_BPS: Record<string, bigint> = {
  "lb_v22_direct": 200n, // binStep 25 → 0.25% × 2 legs + slippage
  "lb_v22_auto":   200n, // default assumption; widened if the quoter picks V1
  "v1_classic":    300n, // V1 AMM 0.3% × 2 legs + slippage + thin-liquidity buffer
  "v1_auto":       400n, // MOE/WMNT V1 — thinner liquidity + higher volatility
};

/** All tokens we snapshot — "no other token moved" is part of consistency. */
const TRACKED_TOKENS: `0x${string}`[] = [WMNT, USDC, USDT, USDT0, USDe, MOE];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sym(addr: string): string {
  return TOKEN_SYMBOL[addr] ?? addr.slice(0, 8);
}

function fmt(raw: bigint, addr: string): string {
  return formatUnits(raw, TOKEN_DECIMALS[addr] ?? 18);
}

async function snapshotBalances(): Promise<Record<string, bigint>> {
  const w = wallet();
  const out: Record<string, bigint> = {};
  await Promise.all(
    TRACKED_TOKENS.map(async (t) => {
      out[t] = await readBalance(w, t);
    }),
  );
  return out;
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

// ---------------------------------------------------------------------------
// Core: swap + consistency asserter. Runs one CLI quote, one CLI build-swap,
// signs + broadcasts locally, then verifies the full consistency contract.
// ---------------------------------------------------------------------------

interface SwapOpts {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: string;
  /** --bin-step forwarded to build-swap. `undefined` = let the quoter choose. */
  binStep?: number;
  /** If provided, assert `pool_params.router_version === this` on the response. */
  expectedRouterVersion?: number;
  /** If provided, assert `pool_params.bin_step === this` on the response. */
  expectedBinStep?: number;
  /**
   * If true, skip the "executed_out ≈ quoted_out" parity check and pass a
   * permissive amount_out_min to build-swap. Use this when the quote and the
   * actual swap hit *different* pools — e.g. the V1 classic AMM path: the
   * CLI's swap-quote goes through the LB Quoter (V2.2 pools), but the signed
   * tx is forced onto a V1 constant-product pool whose price can legitimately
   * diverge from the LB quote by several percent.
   */
  quoteMismatchExpected?: boolean;
}

interface SwapOutcome {
  outDelta: bigint;
  /** What the CLI's response reported — useful for details/debugging. */
  reportedRouterVersion: number | undefined;
  reportedBinStep: number | undefined;
  reportedIntent: string;
}

async function swapAndVerify(opts: SwapOpts): Promise<SwapOutcome> {
  const { tokenIn, tokenOut, amountIn, binStep } = opts;
  const w = wallet();
  const inSym = sym(tokenIn);
  const outSym = sym(tokenOut);

  // ── 1. Quote via CLI ─────────────────────────────────────────────────
  const quote = await runCli([
    "defi", "swap-quote",
    "--in", inSym,
    "--out", outSym,
    "--amount", amountIn,
    "--provider", "merchant_moe",
  ]);
  assertEqual(quote.exitCode, 0, "quote exit code");
  assertEqual(quote.json?.provider, "merchant_moe", "quote.provider");
  const amountInRaw = quote.json?.amount_in_raw as string | undefined;
  const estOutRaw   = quote.json?.estimated_out_raw as string | undefined;
  const minOutRaw   = quote.json?.minimum_out_raw as string | undefined;
  assertDefined(amountInRaw, "quote.amount_in_raw");
  assertDefined(estOutRaw, "quote.estimated_out_raw");
  assertDefined(minOutRaw, "quote.minimum_out_raw");
  const amountInBig = BigInt(amountInRaw);
  const estOut = BigInt(estOutRaw);
  const minOut = BigInt(minOutRaw);

  // ── 2. Pre-swap snapshot ─────────────────────────────────────────────
  const before = await snapshotBalances();

  // ── 3. Build unsigned tx via CLI ─────────────────────────────────────
  // When the quote and the swap target DIFFERENT pools (V1 classic vs LB
  // V2.2), the quote's minimum_out_raw can exceed what the actual pool can
  // deliver → the router would revert with LBRouter__InsufficientAmountOut.
  // In that case we fall back to a nominal amount_out_min=1 and rely on the
  // per-version roundtrip envelope to catch genuinely bad pricing.
  const minOutForBuild = opts.quoteMismatchExpected ? 1n : minOut;
  const buildArgs = [
    "swap", "build-swap",
    "--provider", "merchant_moe",
    "--in", inSym,
    "--out", outSym,
    "--amount", amountIn,
    "--recipient", w.address,
    "--owner", w.address,
    "--amount-out-min", minOutForBuild.toString(),
  ];
  if (typeof binStep === "number") {
    buildArgs.push("--bin-step", String(binStep));
  }
  const tx = await buildTx(buildArgs);

  // Structural assertions about the unsigned tx.
  assertEqual(
    tx.unsigned_tx.to.toLowerCase(),
    MOE_LB_ROUTER.toLowerCase(),
    "unsigned_tx.to === Moe LB Router",
  );
  assertEqual(tx.unsigned_tx.chainId, 5000, "unsigned_tx.chainId");
  assertEqual(
    typeof tx.unsigned_tx.nonce,
    "number",
    "unsigned_tx.nonce pinned at build time",
  );

  // pool_params sanity — varies by code path (see defi-write.js).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pp = (tx as any).pool_params as {
    provider?: string;
    bin_step?: number;
    router_version?: number;
    router_address?: string;
  } | undefined;
  assertEqual(pp?.provider, "merchant_moe", "pool_params.provider");
  assertEqual(
    pp?.router_address?.toLowerCase(),
    MOE_LB_ROUTER.toLowerCase(),
    "pool_params.router_address",
  );
  if (opts.expectedRouterVersion !== undefined) {
    assertEqual(
      pp?.router_version,
      opts.expectedRouterVersion,
      `pool_params.router_version for ${inSym}→${outSym}`,
    );
  }
  if (opts.expectedBinStep !== undefined) {
    assertEqual(
      pp?.bin_step,
      opts.expectedBinStep,
      `pool_params.bin_step for ${inSym}→${outSym}`,
    );
  }

  // ── 4. Local sign + broadcast (no-op under DRY_RUN) ───────────────────
  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (!result) {
    setDetails({
      mode: "dry-run",
      path: binStep === undefined ? "auto" : `--bin-step ${binStep}`,
      in: inSym, out: outSym,
      amount_in: amountIn,
      cli_intent: tx.intent,
      cli_router_version: pp?.router_version,
      cli_bin_step: pp?.bin_step,
      quote_estimate: quote.json?.estimated_out_decimal,
      quote_min: quote.json?.minimum_out_decimal,
    });
    return {
      outDelta: 0n,
      reportedRouterVersion: pp?.router_version,
      reportedBinStep: pp?.bin_step,
      reportedIntent: tx.intent,
    };
  }
  assertEqual(result.receipt.status, "success", "swap tx status");
  trackTx(result.hash);

  // ── 5. Post-swap snapshot + consistency asserts ───────────────────────
  const after = await snapshotBalances();
  const inDelta  = before[tokenIn]  - after[tokenIn];     // expect == amountInBig
  const outDelta = after[tokenOut]  - before[tokenOut];   // expect >= minOut

  // 5a. Exact debit of the input amount.
  assert(
    inDelta === amountInBig,
    `${inSym} debit delta ${inDelta} !== amount_in_raw ${amountInBig}`,
  );

  // 5b. Minimum-out honored — against the bound we actually signed.
  assertGreaterThan(
    outDelta,
    minOutForBuild - 1n,
    `${outSym} received ${outDelta} must be >= amount_out_min ${minOutForBuild}`,
  );

  // 5c. Quote ↔ execution parity — skip when the quote is for a different
  //     pool than the one we executed against (see quoteMismatchExpected).
  if (!opts.quoteMismatchExpected && estOut > 0n) {
    const driftBps = (absDiff(outDelta, estOut) * 10_000n) / estOut;
    assert(
      driftBps <= QUOTE_EXEC_TOLERANCE_BPS,
      `${outSym} drift from quote: got ${outDelta}, quoted ${estOut} ` +
      `(${driftBps} bps > ${QUOTE_EXEC_TOLERANCE_BPS})`,
    );
  }

  // 5d. No other token moved.
  for (const t of TRACKED_TOKENS) {
    if (t === tokenIn || t === tokenOut) continue;
    assert(
      before[t] === after[t],
      `unexpected ${sym(t)} movement: ${before[t]} → ${after[t]}`,
    );
  }

  setDetails({
    path: binStep === undefined ? "auto" : `--bin-step ${binStep}`,
    in: inSym,
    out: outSym,
    amount_in: fmt(amountInBig, tokenIn),
    amount_out: fmt(outDelta, tokenOut),
    quote_estimate: fmt(estOut, tokenOut),
    quote_minimum: fmt(minOut, tokenOut),
    quote_vs_exec_bps: estOut > 0n
      ? ((absDiff(outDelta, estOut) * 10_000n) / estOut).toString()
      : null,
    router_version: pp?.router_version ?? null,
    bin_step: pp?.bin_step ?? null,
    intent: tx.intent,
    gas_used: result.receipt.gasUsed.toString(),
  });

  return {
    outDelta,
    reportedRouterVersion: pp?.router_version,
    reportedBinStep: pp?.bin_step,
    reportedIntent: tx.intent,
  };
}

/**
 * Roundtrip helper: run a forward swap (WMNT → OTHER), then a return swap
 * (OTHER → WMNT) using whatever OTHER balance we just received. Asserts
 * end-to-end WMNT loss within the per-version fee envelope.
 */
async function roundtripWMNT(opts: {
  label: string;
  other: `0x${string}`;
  forwardAmount: string;
  binStep?: number;
  expectedRouterVersion?: number;
  expectedBinStep?: number;
  toleranceLabel: keyof typeof ROUNDTRIP_TOLERANCE_BPS;
  /** Forwarded to swapAndVerify; see SwapOpts.quoteMismatchExpected. */
  quoteMismatchExpected?: boolean;
}): Promise<void> {
  const w = wallet();

  // Approve return leg up-front so the roundtrip doesn't stall mid-way.
  await approveIfNeeded(w, opts.other, MOE_LB_ROUTER, "Moe LB Router");

  // ── Forward: WMNT → OTHER ────────────────────────────────────────────
  const wmntBeforeForward = await readBalance(w, WMNT);
  const forward = await swapAndVerify({
    tokenIn: WMNT,
    tokenOut: opts.other,
    amountIn: opts.forwardAmount,
    binStep: opts.binStep,
    expectedRouterVersion: opts.expectedRouterVersion,
    expectedBinStep: opts.expectedBinStep,
    quoteMismatchExpected: opts.quoteMismatchExpected,
  });

  // ── Return: OTHER → WMNT, using exactly what we got back ─────────────
  const otherBalance = await readBalance(w, opts.other);
  const otherIn = DRY_RUN
    // Nominal non-zero amount so the CLI still produces a realistic tx shape
    // when signed-and-sent is a no-op.
    ? BigInt(10 ** Math.max(TOKEN_DECIMALS[opts.other] - 2, 0))
    : otherBalance;
  // Live: must have *some* other token to swap back — otherwise the forward
  // swap silently did nothing and all our checks downstream are meaningless.
  if (!DRY_RUN) {
    assertGreaterThan(otherIn, 0n, `must have some ${sym(opts.other)} to swap back`);
  }
  const otherInHuman = formatTokenAmount(otherIn, opts.other);

  const wmntBeforeReturn = await readBalance(w, WMNT);
  const ret = await swapAndVerify({
    tokenIn: opts.other,
    tokenOut: WMNT,
    amountIn: otherInHuman,
    binStep: opts.binStep,
    expectedRouterVersion: opts.expectedRouterVersion,
    expectedBinStep: opts.expectedBinStep,
    quoteMismatchExpected: opts.quoteMismatchExpected,
  });

  if (DRY_RUN) return;

  // ── Fee-envelope check: WMNT roundtrip loss ─────────────────────────
  const wmntAfterReturn = await readBalance(w, WMNT);
  // WMNT flow over the roundtrip:
  //   start    = wmntBeforeForward
  //   forward  = -parseEther(forwardAmount) → wmntBeforeReturn
  //   return   = +outDelta                   → wmntAfterReturn
  // So end-to-end loss = start - wmntAfterReturn.
  const loss = wmntBeforeForward - wmntAfterReturn;
  const lossBps = loss > 0n
    ? (loss * 10_000n) / wmntBeforeForward
    : 0n;
  const tolerance = ROUNDTRIP_TOLERANCE_BPS[opts.toleranceLabel];
  assert(
    lossBps <= tolerance,
    `${opts.label} roundtrip loss ${lossBps} bps exceeds tolerance ${tolerance} bps ` +
    `(start=${formatEther(wmntBeforeForward)} WMNT, end=${formatEther(wmntAfterReturn)} WMNT)`,
  );

  setDetails({
    version: opts.toleranceLabel,
    forward_router_version: forward.reportedRouterVersion,
    return_router_version: ret.reportedRouterVersion,
    forward_bin_step: forward.reportedBinStep,
    return_bin_step: ret.reportedBinStep,
    forward_intent: forward.reportedIntent,
    return_intent: ret.reportedIntent,
    roundtrip_loss_bps: lossBps.toString(),
    tolerance_bps: tolerance.toString(),
    wmnt_start: formatEther(wmntBeforeForward),
    wmnt_mid: formatEther(wmntBeforeReturn),
    wmnt_end: formatEther(wmntAfterReturn),
  });
}

// ===========================================================================
// Phase A — Setup: pre-fund WMNT and approve the LB Router once.
// ===========================================================================

test("Ensure WMNT balance (wrap MNT if needed)", async () => {
  const w = wallet();
  const have = await readBalance(w, WMNT);
  const target = parseEther(ENSURE_WMNT);
  if (have >= target) {
    console.log(`  (already ${formatEther(have)} WMNT ≥ ${ENSURE_WMNT})`);
    setDetails({ wmnt: formatEther(have), wrapped: false });
    return;
  }
  const need = target - have;
  const tx = await buildTx([
    "swap", "wrap-mnt",
    "--amount", formatEther(need),
    "--sender", w.address,
  ]);
  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "wrap tx status");
    trackTx(result.hash);
    const after = await readBalance(w, WMNT);
    setDetails({ wrapped: true, wmnt_after: formatEther(after) });
  }
});

test("Approve WMNT → Moe LB Router", async () => {
  await approveIfNeeded(wallet(), WMNT, MOE_LB_ROUTER, "Moe LB Router");
  setDetails({ approved: true });
});

// ===========================================================================
// Phase B — Version 1: LB V2.2 direct via explicit --bin-step.
// WMNT/USDC has a known LB pool at binStep 25 (constants.ts: moe_wmnt_usdc).
// Expect: router_version = 3, bin_step = 25.
// ===========================================================================

test("Moe [LB V2.2 direct, --bin-step 25]: WMNT↔USDC roundtrip", async () => {
  await roundtripWMNT({
    label: "LB V2.2 direct WMNT↔USDC",
    other: USDC,
    forwardAmount: WMNT_V22_DIRECT,
    binStep: 25,
    expectedRouterVersion: 3,
    expectedBinStep: 25,
    toleranceLabel: "lb_v22_direct",
  });
});

// ===========================================================================
// Phase C — Version 2: LB V2.2 auto-routed (on-chain Quoter picks).
// WMNT/USDT0 has a direct LB pool; quoter should pick it. The response uses
// buildMoeMultihopSwapFromQuoter which omits router_version (undefined) and
// fills bin_step from the quoter's choice. We don't pin router_version here —
// we only verify the route came back and is routable via the LB router.
// ===========================================================================

test("Moe [LB V2.2 auto-routed, no --bin-step]: WMNT↔USDT0 roundtrip", async () => {
  await roundtripWMNT({
    label: "LB V2.2 auto WMNT↔USDT0",
    other: USDT0,
    forwardAmount: WMNT_V22_AUTO,
    // No binStep → CLI uses LB Quoter on-chain discovery.
    binStep: undefined,
    // router_version is undefined on the quoter-route response path (the
    // versions[] live inside the encoded calldata, not in pool_params).
    expectedRouterVersion: undefined,
    // Quoter picks its own binStep; don't pin a value.
    expectedBinStep: undefined,
    toleranceLabel: "lb_v22_auto",
  });
});

// ===========================================================================
// Phase D — Version 3: Classic V1 AMM via --bin-step 0.
// USDe/WMNT has a V1 pool (dex-pairs.js: MOE_V1_PAIRS, 0x43dB…C1F0). Passing
// --bin-step 0 makes the CLI's factory check for binStep=0 miss, so
// routerVersion stays 0 and the swap routes through the V1 pool via the LB
// router's V1-compat path.
// Expect: router_version = 0, bin_step = 0, intent = "swap".
// ===========================================================================

test("Moe [V1 classic AMM, --bin-step 0]: WMNT↔USDe roundtrip", async () => {
  await roundtripWMNT({
    label: "V1 classic WMNT↔USDe",
    other: USDe,
    forwardAmount: WMNT_V1_CLASSIC,
    binStep: 0,
    expectedRouterVersion: 0,
    expectedBinStep: 0,
    toleranceLabel: "v1_classic",
    // `swap-quote --provider merchant_moe` prices against the LB Quoter
    // (V2.2 pools) — but with --bin-step 0 we force the swap onto the V1
    // classic AMM pool, whose pricing can legitimately diverge by a few
    // percent. Disable quote-exec parity + use a permissive amount_out_min;
    // the per-version roundtrip envelope (300 bps) still guards correctness.
    quoteMismatchExpected: true,
  });
});

// ===========================================================================
// Phase E — Version 4: V1 auto-discovered (MOE/WMNT).
// MOE has *no* LB pool with WMNT — only a V1 classic AMM pool at
//   0x763868612858358f62b05691dB82Ad35a9b3E110  (dex-pairs.js: MOE_V1_PAIRS).
// When the CLI runs `swap-quote` without --bin-step, the on-chain LB Quoter
// inspects V1 as well and returns that pool as the only route (confirmed:
// quote.route = "onchain:merchant_moe:0x7638…E110", bin_step = 0).
// Because the quote and the swap hit the *same* V1 pool, we can keep full
// quote↔exec parity enabled — unlike Phase D, where we forced --bin-step 0
// against a quote that priced the LB pool.
//
// Expect (auto-route → buildMoeMultihopSwapFromQuoter):
//   pool_params.bin_step = 0       (quoter reported V1)
//   pool_params.router_version = undefined  (not populated on the auto path)
// ===========================================================================

test("Moe [V1 auto-discovered, no --bin-step]: WMNT↔MOE roundtrip", async () => {
  await roundtripWMNT({
    label: "V1 auto WMNT↔MOE",
    other: MOE,
    forwardAmount: WMNT_V1_AUTO,
    binStep: undefined,
    // buildMoeMultihopSwapFromQuoter does NOT populate router_version in the
    // response (the versions[] array lives inside the encoded calldata only).
    expectedRouterVersion: undefined,
    // But it DOES surface the quoter's chosen bin_step, which must be 0 for
    // a V1-only pair — this is how we prove the V1 path was selected.
    expectedBinStep: 0,
    toleranceLabel: "v1_auto",
  });
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runScenario({
  name: "Merchant Moe Multi-Version Swap Consistency",
  description:
    "Roundtrip WMNT ↔ {USDC, USDT0, USDe, MOE} across four distinct Moe swap " +
    "paths (LB V2.2 explicit binStep, LB V2.2 auto-routed, classic V1 AMM " +
    "forced via --bin-step 0, V1 auto-discovered via LB Quoter) using " +
    "mantle-cli + local signing. Asserts router_version/bin_step from the " +
    "CLI response, exact input debit, min-out honored, quote↔exec parity ≤ 1%, " +
    "no collateral token movement, and per-version roundtrip fee envelope.",
  livePreview: [
    `Version 1 (LB V2.2 direct):   ${WMNT_V22_DIRECT} WMNT ↔ USDC with --bin-step 25`,
    `Version 2 (LB V2.2 auto):     ${WMNT_V22_AUTO} WMNT ↔ USDT0 (on-chain quoter)`,
    `Version 3 (V1 forced):        ${WMNT_V1_CLASSIC} WMNT ↔ USDe  with --bin-step 0`,
    `Version 4 (V1 auto):          ${WMNT_V1_AUTO} WMNT ↔ MOE  (quoter picks V1; no LB pool)`,
    `Ensures:   ~${ENSURE_WMNT} WMNT pre-funded (wraps MNT if short)`,
    `Check:     quote↔exec ≤ ${QUOTE_EXEC_TOLERANCE_BPS} bps, roundtrip ≤ per-version envelope`,
  ],
});
