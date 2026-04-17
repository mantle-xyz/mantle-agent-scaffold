/**
 * Scenario 1 — Swap roundtrips on Merchant Moe and Agni.
 *
 * Simulates an external agent (Privy wallet + mantle-cli) doing a WMNT ↔ USDe
 * roundtrip on each DEX. Intent is to exercise the CLI surface — we pass only
 * business-level parameters and let the CLI resolve pools, routes, etc.
 *
 * Flow (requires ≥0.5 MNT + some WMNT; script wraps if needed):
 *   A. Ensure we have ≥0.5 WMNT (wrap MNT if not).
 *   B. Moe:  approve WMNT → LB Router; swap 0.1 WMNT → USDe; swap USDe → WMNT.
 *   C. Agni: approve WMNT → SwapRouter; swap 0.1 WMNT → USDe; swap USDe → WMNT.
 *
 * Usage:
 *   TEST_PRIVATE_KEY=0x... npm run test:swap         # live on mainnet
 *   TEST_PRIVATE_KEY=0x... npm run test:swap:dry     # dry-run (no broadcast)
 */

import { parseEther, formatEther } from "viem";

import { signAndSend } from "./wallet.js";
import { buildTx, runCli } from "./cli.js";
import { test, setDetails } from "./runner.js";
import { assertEqual, assertDefined } from "./assert.js";
import {
  DRY_RUN,
  approveIfNeeded,
  readBalance,
  resetAllowance,
  trackTx,
  runScenario,
  wallet,
} from "./helpers.js";
import {
  WMNT,
  USDe,
  AGNI_SWAP_ROUTER,
  MOE_LB_ROUTER,
} from "./constants.js";

// --- Amounts ----------------------------------------------------------------
const SWAP_WMNT_AMOUNT = "0.1";   // WMNT-in amount per provider
const ENSURE_WMNT      = "0.5";   // wrap up to this much WMNT at start

// ---------------------------------------------------------------------------
// Setup: reset all relevant allowances to 0 before the scenario runs.
// This ensures every `approve` step below executes (no "already sufficient"
// skips), making each run produce a complete, deterministic trace.
// ---------------------------------------------------------------------------

test("Setup: reset WMNT/USDe allowances for Moe + Agni to 0", async () => {
  const w = wallet();
  await resetAllowance(w, WMNT, MOE_LB_ROUTER,     "Moe LB Router");
  await resetAllowance(w, USDe, MOE_LB_ROUTER,     "Moe LB Router");
  await resetAllowance(w, WMNT, AGNI_SWAP_ROUTER,  "Agni SwapRouter");
  await resetAllowance(w, USDe, AGNI_SWAP_ROUTER,  "Agni SwapRouter");
  setDetails({ allowances_reset: true });
});

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
  const quote = await runCli([
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
  // Use whatever USDe we currently hold as the swap-in amount.
  const usdeBalance = await readBalance(w, USDe);
  const swapIn = DRY_RUN ? SWAP_WMNT_AMOUNT : formatEther(usdeBalance);

  const quote = await runCli([
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
// C — Agni swap roundtrip
// ---------------------------------------------------------------------------

test("Agni: approve WMNT for SwapRouter", async () => {
  await approveIfNeeded(wallet(), WMNT, AGNI_SWAP_ROUTER, "Agni SwapRouter");
  setDetails({ approved: true });
});

test("Agni: swap WMNT → USDe", async () => {
  const w = wallet();
  const quote = await runCli([
    "defi", "swap-quote",
    "--in", "WMNT", "--out", "USDe",
    "--amount", SWAP_WMNT_AMOUNT,
    "--provider", "agni",
  ]);
  assertEqual(quote.exitCode, 0, "quote exit code");
  const minOut = quote.json?.minimum_out_raw;
  assertDefined(minOut, "minimum_out_raw");

  const before = await readBalance(w, USDe);
  const tx = await buildTx([
    "swap", "build-swap",
    "--provider", "agni",
    "--in", "WMNT", "--out", "USDe",
    "--amount", SWAP_WMNT_AMOUNT,
    "--recipient", w.address,
    "--amount-out-min", minOut,
  ]);
  assertEqual(tx.unsigned_tx.to.toLowerCase(), AGNI_SWAP_ROUTER.toLowerCase(), "to == Agni SwapRouter");
  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    const after = await readBalance(w, USDe);
    setDetails({
      usde_received: formatEther(after - before),
      intent: tx.intent,
    });
  }
});

test("Agni: approve USDe for SwapRouter", async () => {
  await approveIfNeeded(wallet(), USDe, AGNI_SWAP_ROUTER, "Agni SwapRouter");
  setDetails({ approved: true });
});

test("Agni: swap USDe → WMNT (roundtrip back)", async () => {
  const w = wallet();
  const usdeBalance = await readBalance(w, USDe);
  const swapIn = DRY_RUN ? "0.1" : formatEther(usdeBalance);

  const quote = await runCli([
    "defi", "swap-quote",
    "--in", "USDe", "--out", "WMNT",
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
// Teardown: restore allowances to 0 so the wallet ends in the same state
// it was in before the scenario started.
// ---------------------------------------------------------------------------

test("Teardown: reset WMNT/USDe allowances for Moe + Agni to 0", async () => {
  const w = wallet();
  await resetAllowance(w, WMNT, MOE_LB_ROUTER,     "Moe LB Router");
  await resetAllowance(w, USDe, MOE_LB_ROUTER,     "Moe LB Router");
  await resetAllowance(w, WMNT, AGNI_SWAP_ROUTER,  "Agni SwapRouter");
  await resetAllowance(w, USDe, AGNI_SWAP_ROUTER,  "Agni SwapRouter");
  setDetails({ allowances_reset: true });
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runScenario({
  name: "Swap Scenario: WMNT↔USDe on Moe + Agni",
  description:
    "Roundtrip 0.1 WMNT → USDe → WMNT on each DEX to exercise the swap CLI surface.",
  livePreview: [
    `1. Wrap up to ${ENSURE_WMNT} MNT → WMNT (if needed)`,
    `2. Moe:  swap ${SWAP_WMNT_AMOUNT} WMNT → USDe, then USDe → WMNT`,
    `3. Agni: swap ${SWAP_WMNT_AMOUNT} WMNT → USDe, then USDe → WMNT`,
  ],
});
