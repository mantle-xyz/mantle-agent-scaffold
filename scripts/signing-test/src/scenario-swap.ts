/**
 * Scenario 1 — Swap roundtrips on Merchant Moe and Agni.
 *
 * Flow (requires ≥0.5 MNT + some WMNT; script wraps if needed):
 *   A. Ensure we have ≥0.5 WMNT (wrap MNT if not).
 *   B. Moe:  approve WMNT → LB Router; swap 0.1 WMNT → USDe; swap received USDe → WMNT.
 *   C. Agni: approve WMNT → SwapRouter; swap 0.1 WMNT → USDC; swap received USDC → WMNT.
 *
 * Note on pair choice:
 *   Moe has a direct WMNT/USDe pool (binStep 25) registered in the router's pair graph,
 *   so WMNT↔USDe works end-to-end. Agni's pair graph does NOT register WMNT/USDe — the
 *   dex registry only has WMNT/USDC, WMNT/USDT, WETH/WMNT, etc. Chained routes through
 *   USDC→USDe aren't stitched together by the current quoter, so we use WMNT↔USDC on
 *   Agni. Both sides still exercise the same signing pipeline (approve → swap → swap).
 *
 * Usage:
 *   TEST_PRIVATE_KEY=0x... npm run test:swap         # live on mainnet
 *   TEST_PRIVATE_KEY=0x... npm run test:swap:dry     # dry-run (no broadcast)
 */

import { parseEther, formatEther, formatUnits } from "viem";

import {
  signAndSend,
} from "./wallet.js";
import { buildTx } from "./cli.js";
import { test, setDetails } from "./runner.js";
import { assertEqual, assertDefined } from "./assert.js";
import {
  DRY_RUN,
  approveIfNeeded,
  readBalance,
  trackTx,
  runScenario,
  wallet,
} from "./helpers.js";
import {
  WMNT,
  USDC,
  USDe,
  AGNI_SWAP_ROUTER,
  MOE_LB_ROUTER,
} from "./constants.js";

// --- Amounts ----------------------------------------------------------------
const SWAP_WMNT_AMOUNT = "0.1";   // WMNT-in amount per provider
const ENSURE_WMNT      = "0.5";   // wrap up to this much WMNT at start

// ---------------------------------------------------------------------------
// A — Ensure WMNT balance
// ---------------------------------------------------------------------------

test("Ensure WMNT balance (wrap MNT if needed)", async () => {
  const w = wallet();
  const wmntBalance = await readBalance(w, WMNT);
  const target = parseEther(ENSURE_WMNT);
  if (wmntBalance >= target) {
    console.log(`  (already have ${formatEther(wmntBalance)} WMNT ≥ ${ENSURE_WMNT}, no wrap needed)`);
    setDetails({ wmnt_balance: formatEther(wmntBalance), wrapped: false });
    return;
  }

  const needed = target - wmntBalance;
  const wrapAmount = formatEther(needed);
  const tx = await buildTx(["swap", "wrap-mnt", "--amount", wrapAmount]);
  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "wrap tx status");
    trackTx(result.hash);
    const after = await readBalance(w, WMNT);
    setDetails({
      wrapped_amount: wrapAmount,
      wmnt_after: formatEther(after),
    });
  }
});

// ---------------------------------------------------------------------------
// B — Moe swap roundtrip
// ---------------------------------------------------------------------------

test("Moe: approve WMNT for LB Router", async () => {
  await approveIfNeeded(wallet(), WMNT, MOE_LB_ROUTER, "Moe LB Router");
  setDetails({ approved: true });
});

test("Moe: swap WMNT → USDe", async () => {
  const w = wallet();
  const quote = await (await import("./cli.js")).runCli([
    "defi", "swap-quote",
    "--in", "WMNT", "--out", "USDe",
    "--amount", SWAP_WMNT_AMOUNT,
    "--provider", "merchant_moe",
  ]);
  assertEqual(quote.exitCode, 0, "quote exit code");
  const minOut = quote.json?.minimum_out_raw;
  assertDefined(minOut, "minimum_out_raw");

  const before = await readBalance(w, USDe);
  const tx = await buildTx([
    "swap", "build-swap",
    "--provider", "merchant_moe",
    "--in", "WMNT", "--out", "USDe",
    "--amount", SWAP_WMNT_AMOUNT,
    "--recipient", w.address,
    "--amount-out-min", minOut,
  ]);
  assertEqual(tx.unsigned_tx.to.toLowerCase(), MOE_LB_ROUTER.toLowerCase(), "to == Moe LB Router");
  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    const after = await readBalance(w, USDe);
    setDetails({
      usde_received: formatEther(after - before),
      quote_minimum: quote.json?.minimum_out,
    });
  }
});

test("Moe: approve USDe for LB Router", async () => {
  await approveIfNeeded(wallet(), USDe, MOE_LB_ROUTER, "Moe LB Router");
  setDetails({ approved: true });
});

test("Moe: swap USDe → WMNT (roundtrip back)", async () => {
  const w = wallet();
  // Swap back what USDe we just received (use current balance as input).
  const usdeBalance = await readBalance(w, USDe);
  if (usdeBalance === 0n && DRY_RUN) {
    console.log("  (DRY_RUN: no USDe yet, would use quote_result balance)");
  }
  // Leave a small dust balance behind to account for rounding on live.
  // For dry-run use SWAP_WMNT_AMOUNT-worth of USDe as input (approximated).
  const swapIn = DRY_RUN ? SWAP_WMNT_AMOUNT : formatEther(usdeBalance);

  const quote = await (await import("./cli.js")).runCli([
    "defi", "swap-quote",
    "--in", "USDe", "--out", "WMNT",
    "--amount", swapIn,
    "--provider", "merchant_moe",
  ]);
  assertEqual(quote.exitCode, 0, "quote exit code");
  const minOut = quote.json?.minimum_out_raw;
  assertDefined(minOut, "minimum_out_raw");

  const wmntBefore = await readBalance(w, WMNT);
  const tx = await buildTx([
    "swap", "build-swap",
    "--provider", "merchant_moe",
    "--in", "USDe", "--out", "WMNT",
    "--amount", swapIn,
    "--recipient", w.address,
    "--amount-out-min", minOut,
  ]);
  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    const wmntAfter = await readBalance(w, WMNT);
    setDetails({
      wmnt_received: formatEther(wmntAfter - wmntBefore),
      roundtrip_spent: SWAP_WMNT_AMOUNT,
    });
  }
});

// ---------------------------------------------------------------------------
// C — Agni swap roundtrip (WMNT ↔ USDC; Agni has no WMNT/USDe in its pair graph)
// ---------------------------------------------------------------------------

test("Agni: approve WMNT for SwapRouter", async () => {
  await approveIfNeeded(wallet(), WMNT, AGNI_SWAP_ROUTER, "Agni SwapRouter");
  setDetails({ approved: true });
});

test("Agni: swap WMNT → USDC", async () => {
  const w = wallet();
  const quote = await (await import("./cli.js")).runCli([
    "defi", "swap-quote",
    "--in", "WMNT", "--out", "USDC",
    "--amount", SWAP_WMNT_AMOUNT,
    "--provider", "agni",
  ]);
  assertEqual(quote.exitCode, 0, "quote exit code");
  const minOut = quote.json?.minimum_out_raw;
  assertDefined(minOut, "minimum_out_raw");

  const before = await readBalance(w, USDC);
  const tx = await buildTx([
    "swap", "build-swap",
    "--provider", "agni",
    "--in", "WMNT", "--out", "USDC",
    "--amount", SWAP_WMNT_AMOUNT,
    "--recipient", w.address,
    "--amount-out-min", minOut,
  ]);
  assertEqual(tx.unsigned_tx.to.toLowerCase(), AGNI_SWAP_ROUTER.toLowerCase(), "to == Agni SwapRouter");
  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    const after = await readBalance(w, USDC);
    setDetails({
      usdc_received: formatUnits(after - before, 6),
      intent: tx.intent,
    });
  }
});

test("Agni: approve USDC for SwapRouter", async () => {
  await approveIfNeeded(wallet(), USDC, AGNI_SWAP_ROUTER, "Agni SwapRouter");
  setDetails({ approved: true });
});

test("Agni: swap USDC → WMNT (roundtrip back)", async () => {
  const w = wallet();
  const usdcBalance = await readBalance(w, USDC);
  // For dry-run we don't have real USDC from the prior swap, so use a tiny fixed amount.
  const swapIn = DRY_RUN ? "0.1" : formatUnits(usdcBalance, 6);

  const quote = await (await import("./cli.js")).runCli([
    "defi", "swap-quote",
    "--in", "USDC", "--out", "WMNT",
    "--amount", swapIn,
    "--provider", "agni",
  ]);
  assertEqual(quote.exitCode, 0, "quote exit code");
  const minOut = quote.json?.minimum_out_raw;
  assertDefined(minOut, "minimum_out_raw");

  const wmntBefore = await readBalance(w, WMNT);
  const tx = await buildTx([
    "swap", "build-swap",
    "--provider", "agni",
    "--in", "USDC", "--out", "WMNT",
    "--amount", swapIn,
    "--recipient", w.address,
    "--amount-out-min", minOut,
  ]);
  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    const wmntAfter = await readBalance(w, WMNT);
    setDetails({
      wmnt_received: formatEther(wmntAfter - wmntBefore),
      roundtrip_spent: SWAP_WMNT_AMOUNT,
    });
  }
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runScenario({
  name: "Swap Scenario: Moe WMNT↔USDe + Agni WMNT↔USDC",
  description:
    "Roundtrip 0.1 WMNT → stablecoin → WMNT on each DEX (Moe pair: USDe, Agni pair: USDC).",
  livePreview: [
    `1. Wrap up to ${ENSURE_WMNT} MNT → WMNT (if needed)`,
    `2. Moe:  swap ${SWAP_WMNT_AMOUNT} WMNT → USDe, then USDe → WMNT`,
    `3. Agni: swap ${SWAP_WMNT_AMOUNT} WMNT → USDC, then USDC → WMNT`,
  ],
});
