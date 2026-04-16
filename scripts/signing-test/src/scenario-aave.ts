/**
 * Scenario 3 — Aave V3 lending roundtrip on Mantle.
 *
 * Flow:
 *   0. Pre-test cleanup: detect any leftover Aave positions from a prior
 *      crashed/incomplete run and unwind them so the test starts from a
 *      clean slate (skipped in DRY_RUN). Order: withdraw non-collateral
 *      supplies → repay all debts → withdraw collateral supplies.
 *   1. Ensure ≥ENSURE_WMNT WMNT (wrap MNT if needed); approve WMNT → Moe LB
 *      Router; swap WMNT → USDT0 to acquire the USDT0 we supply in step 3.
 *      The swap is skipped if cleanup or initial state already left enough
 *      USDT0 in the wallet.
 *   2. Approve WMNT  → Aave Pool,  supply 0.5 WMNT
 *   3. Approve USDT0 → Aave Pool,  supply 0.5 USDT0
 *   4. Enable WMNT as collateral (setUserUseReserveAsCollateral)
 *   5. Borrow 0.05 USDT0 (variable rate)
 *   6. Withdraw the supplied USDT0 (max)
 *   7. Repay the USDT0 debt (max) — approves USDT0 again since amount > prior allowance may be needed
 *   8. Withdraw the supplied WMNT (max)
 *   9. Verify positions are empty
 *
 * Idempotency: the test leaves Aave empty on success (steps 6-8) and
 * recovers from prior partial runs at start (step 0), so back-to-back
 * runs always begin from the same baseline state.
 *
 * Usage:
 *   TEST_PRIVATE_KEY=0x... npm run test:aave          # live on mainnet
 *   TEST_PRIVATE_KEY=0x... npm run test:aave:dry      # dry-run
 */

import { formatEther, formatUnits, parseEther, parseUnits } from "viem";

import { signAndSend } from "./wallet.js";
import { buildTx, runCli } from "./cli.js";
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
  USDT0,
  AAVE_POOL,
  MOE_LB_ROUTER,
  CHAIN_ID,
} from "./constants.js";

// --- Amounts ----------------------------------------------------------------
const SUPPLY_WMNT  = "0.5";
const SUPPLY_USDT0 = "0.5";
const BORROW_USDT0 = "0.05";
// WMNT to swap for USDT0 — must yield ≥ SUPPLY_USDT0 after slippage. WMNT is
// roughly $0.4-0.5, so 1.5 WMNT comfortably yields ≥ 0.5 USDT0.
const SWAP_WMNT_FOR_USDT0 = "1.5";
// Total WMNT we need on hand: SUPPLY_WMNT + SWAP_WMNT_FOR_USDT0 plus a small
// buffer for gas/dust accounting.
const ENSURE_WMNT = "2.1";

// ---------------------------------------------------------------------------
// 0. Pre-test cleanup: detect any pre-existing Aave positions (e.g. left over
//    from a crashed prior run) and unwind them so each test starts from a
//    clean slate.
//
//    Order matters for HF safety:
//      a) Withdraw NON-collateral supplies first (no HF impact, frees tokens
//         that may be needed to repay).
//      b) Repay all debts (must come before collateral withdrawal — withdrawing
//         collateral with outstanding debt would tank the health factor).
//      c) Withdraw remaining (collateral) supplies — debt is now zero so the
//         HF is effectively infinite.
//    Skipped in DRY_RUN since cleanup must actually broadcast txs to be useful.
// ---------------------------------------------------------------------------

test("Aave: cleanup any pre-existing positions (reset to clean state)", async () => {
  const w = wallet();
  if (DRY_RUN) {
    setDetails({ skipped: true, reason: "dry_run" });
    return;
  }

  type Pos = {
    symbol: string;
    underlying: string;
    decimals: number;
    supplied: string;
    supplied_raw: string;
    total_debt: string;
    total_debt_raw: string;
    variable_debt: string;
    collateral_enabled: boolean | null;
  };

  const fetchPositions = async (): Promise<Pos[]> => {
    const res = await runCli(["aave", "positions", "--user", w.address]);
    assertEqual(res.exitCode, 0, "aave positions exit code");
    assertDefined(res.json, "positions json");
    return (res.json.positions ?? []) as Pos[];
  };

  const positions = await fetchPositions();
  const debts = positions.filter((p) => p.total_debt_raw !== "0");
  const supplies = positions.filter((p) => p.supplied_raw !== "0");

  if (debts.length === 0 && supplies.length === 0) {
    console.log("  (no existing Aave positions — already clean)");
    setDetails({ cleanup_needed: false });
    return;
  }

  console.log(
    `  Found ${supplies.length} supply + ${debts.length} debt position(s); unwinding...`,
  );
  for (const s of supplies) {
    const flag = s.collateral_enabled === true ? " (collateral)" : "";
    console.log(`    supply: ${s.supplied} ${s.symbol}${flag}`);
  }
  for (const d of debts) {
    console.log(`    debt:   ${d.total_debt} ${d.symbol}`);
  }

  // collateral_enabled === null means we couldn't read the bitmap — treat as
  // collateral (the safer assumption: we'll wait until debts are repaid).
  const nonCollateralSupplies = supplies.filter((p) => p.collateral_enabled === false);
  const collateralSupplies = supplies.filter((p) => p.collateral_enabled !== false);

  const aaveWithdraw = async (asset: string, label: string) => {
    console.log(`  Withdrawing ${asset} (${label}, max)...`);
    const tx = await buildTx([
      "aave", "withdraw",
      "--asset", asset,
      "--amount", "max",
      "--to", w.address,
    ]);
    const result = await signAndSend(w, tx.unsigned_tx, { dryRun: false });
    if (result) {
      assertEqual(result.receipt.status, "success", `withdraw ${asset} status`);
      trackTx(result.hash);
    }
  };

  // a) Withdraw non-collateral supplies first (no HF impact)
  for (const s of nonCollateralSupplies) {
    await aaveWithdraw(s.symbol, "non-collateral");
  }

  // b) Repay all debts (approve underlying first; max-approve is idempotent)
  for (const d of debts) {
    console.log(`  Repaying ${d.symbol} debt (max)...`);
    await approveIfNeeded(w, d.underlying, AAVE_POOL, "Aave Pool");
    const tx = await buildTx([
      "aave", "repay",
      "--asset", d.symbol,
      "--amount", "max",
      "--on-behalf-of", w.address,
    ]);
    const result = await signAndSend(w, tx.unsigned_tx, { dryRun: false });
    if (result) {
      assertEqual(result.receipt.status, "success", `repay ${d.symbol} status`);
      trackTx(result.hash);
    }
  }

  // c) Withdraw remaining (collateral) supplies — debt is now zero
  for (const s of collateralSupplies) {
    await aaveWithdraw(s.symbol, "collateral");
  }

  // Verify clean. Allow tiny dust (sub-micro-unit) from in-flight interest
  // accrued between the repay broadcast and the verify read.
  const after = await fetchPositions();
  const remaining = after.filter(
    (p) => Number(p.supplied) > 0.000001 || Number(p.total_debt) > 0.000001,
  );

  setDetails({
    cleanup_needed: true,
    non_collateral_withdrawn: nonCollateralSupplies.length,
    debts_repaid: debts.length,
    collateral_withdrawn: collateralSupplies.length,
    remaining_positions: remaining.length,
  });

  if (remaining.length > 0) {
    throw new Error(
      `cleanup failed — still have non-zero positions: ` +
        remaining
          .map((p) => `${p.symbol}(supply=${p.supplied},debt=${p.total_debt})`)
          .join(", "),
    );
  }
});

// ---------------------------------------------------------------------------
// 1. Prep: ensure WMNT balance + acquire USDT0 by swapping WMNT → USDT0 (Moe).
//    Without this, step 3 ("Aave: supply USDT0") fails because the wallet has
//    no USDT0 to supply.
// ---------------------------------------------------------------------------

test("Ensure WMNT balance for supply + USDT0 swap (wrap MNT if needed)", async () => {
  const w = wallet();
  const wmntBalance = await readBalance(w, WMNT);
  const target = parseEther(ENSURE_WMNT);
  if (wmntBalance >= target) {
    console.log(
      `  (already have ${formatEther(wmntBalance)} WMNT ≥ ${ENSURE_WMNT}, no wrap needed)`,
    );
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

test("Moe: approve WMNT for LB Router (USDT0 acquisition swap)", async () => {
  if (!DRY_RUN) {
    const w = wallet();
    const usdt0Balance = await readBalance(w, USDT0);
    const need = parseUnits(SUPPLY_USDT0, 6);
    if (usdt0Balance >= need) {
      console.log(
        `  (already have ${formatUnits(usdt0Balance, 6)} USDT0 ≥ ${SUPPLY_USDT0}, no swap needed → skipping approve)`,
      );
      setDetails({ skipped: true, reason: "usdt0_balance_sufficient" });
      return;
    }
  }
  await approveIfNeeded(wallet(), WMNT, MOE_LB_ROUTER, "Moe LB Router");
  setDetails({ approved: true });
});

test(`Acquire USDT0: swap ${SWAP_WMNT_FOR_USDT0} WMNT → USDT0 on Moe (skip if balance sufficient)`, async () => {
  const w = wallet();
  // Skip if cleanup or pre-existing balance already gave us enough USDT0.
  if (!DRY_RUN) {
    const usdt0Balance = await readBalance(w, USDT0);
    const need = parseUnits(SUPPLY_USDT0, 6);
    if (usdt0Balance >= need) {
      console.log(
        `  (already have ${formatUnits(usdt0Balance, 6)} USDT0 ≥ ${SUPPLY_USDT0}, no swap needed)`,
      );
      setDetails({
        skipped: true,
        usdt0_balance: formatUnits(usdt0Balance, 6),
      });
      return;
    }
  }

  const quote = await runCli([
    "defi", "swap-quote",
    "--in", "WMNT", "--out", "USDT0",
    "--amount", SWAP_WMNT_FOR_USDT0,
    "--provider", "merchant_moe",
  ]);
  assertEqual(quote.exitCode, 0, "quote exit code");
  const minOut = quote.json?.minimum_out_raw;
  assertDefined(minOut, "minimum_out_raw");

  const usdt0Before = await readBalance(w, USDT0);
  const tx = await buildTx([
    "swap", "build-swap",
    "--provider", "merchant_moe",
    "--in", "WMNT", "--out", "USDT0",
    "--amount", SWAP_WMNT_FOR_USDT0,
    "--recipient", w.address,
    "--owner", w.address,
    "--amount-out-min", minOut,
  ]);
  assertEqual(
    tx.unsigned_tx.to.toLowerCase(),
    MOE_LB_ROUTER.toLowerCase(),
    "to should be Moe LB Router",
  );

  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    const usdt0After = await readBalance(w, USDT0);
    const received = usdt0After - usdt0Before;
    setDetails({
      usdt0_received: formatUnits(received, 6),
      quote_minimum: quote.json?.minimum_out,
    });
    // Sanity-check we got enough USDT0 to fund the upcoming Aave supply.
    if (!DRY_RUN) {
      const need = parseUnits(SUPPLY_USDT0, 6);
      if (usdt0After < need) {
        throw new Error(
          `swap yielded ${formatUnits(usdt0After, 6)} USDT0 but ` +
            `${SUPPLY_USDT0} USDT0 required for Aave supply — increase SWAP_WMNT_FOR_USDT0`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 2–3. Approve + supply WMNT, USDT0
// ---------------------------------------------------------------------------

test("Aave: approve WMNT for Pool", async () => {
  await approveIfNeeded(wallet(), WMNT, AAVE_POOL, "Aave Pool");
  setDetails({ approved: true });
});

test(`Aave: supply ${SUPPLY_WMNT} WMNT`, async () => {
  const w = wallet();
  const tx = await buildTx([
    "aave", "supply",
    "--asset", "WMNT",
    "--amount", SUPPLY_WMNT,
    "--on-behalf-of", w.address,
  ]);
  assertEqual(tx.intent, "aave_supply", "intent");
  assertEqual(tx.unsigned_tx.chainId, CHAIN_ID, "chainId");
  assertEqual(
    tx.unsigned_tx.to.toLowerCase(),
    AAVE_POOL.toLowerCase(),
    "to should be Aave Pool",
  );

  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    setDetails({
      supplied: SUPPLY_WMNT,
      gas_used: result.receipt.gasUsed.toString(),
    });
  }
});

test("Aave: approve USDT0 for Pool", async () => {
  await approveIfNeeded(wallet(), USDT0, AAVE_POOL, "Aave Pool");
  setDetails({ approved: true });
});

test(`Aave: supply ${SUPPLY_USDT0} USDT0`, async () => {
  const w = wallet();
  const tx = await buildTx([
    "aave", "supply",
    "--asset", "USDT0",
    "--amount", SUPPLY_USDT0,
    "--on-behalf-of", w.address,
  ]);
  assertEqual(tx.intent, "aave_supply", "intent");
  assertEqual(
    tx.unsigned_tx.to.toLowerCase(),
    AAVE_POOL.toLowerCase(),
    "to should be Aave Pool",
  );

  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    setDetails({
      supplied: SUPPLY_USDT0,
      gas_used: result.receipt.gasUsed.toString(),
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Enable WMNT as collateral
// ---------------------------------------------------------------------------

test("Aave: enable WMNT as collateral", async () => {
  const w = wallet();
  // Natural agent call: always pass --user so the CLI can preflight.
  // In dry-run the prior supply wasn't broadcast — if the preflight flags that
  // as an error, it's real CLI/core behaviour we want to surface rather than
  // hide by dropping --user.
  const tx = await buildTx([
    "aave", "set-collateral",
    "--asset", "WMNT",
    "--user", w.address,
  ]);
  // Intent may be aave_set_collateral or a skip variant — check to address anyway.
  assertEqual(
    tx.unsigned_tx.to.toLowerCase(),
    AAVE_POOL.toLowerCase(),
    "to should be Aave Pool",
  );

  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    setDetails({
      intent: tx.intent,
      gas_used: result.receipt.gasUsed.toString(),
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Borrow USDT0
// ---------------------------------------------------------------------------

test(`Aave: borrow ${BORROW_USDT0} USDT0`, async () => {
  const w = wallet();
  const usdt0Before = await readBalance(w, USDT0);

  const tx = await buildTx([
    "aave", "borrow",
    "--asset", "USDT0",
    "--amount", BORROW_USDT0,
    "--on-behalf-of", w.address,
  ]);
  assertEqual(tx.intent, "aave_borrow", "intent");
  assertEqual(
    tx.unsigned_tx.to.toLowerCase(),
    AAVE_POOL.toLowerCase(),
    "to should be Aave Pool",
  );

  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    const usdt0After = await readBalance(w, USDT0);
    setDetails({
      borrowed: BORROW_USDT0,
      usdt0_delta: formatUnits(usdt0After - usdt0Before, 6),
      gas_used: result.receipt.gasUsed.toString(),
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Withdraw supplied USDT0 (before repaying, while WMNT still backs the debt)
// ---------------------------------------------------------------------------

test("Aave: withdraw supplied USDT0 (max)", async () => {
  const w = wallet();
  const usdt0Before = await readBalance(w, USDT0);

  const tx = await buildTx([
    "aave", "withdraw",
    "--asset", "USDT0",
    "--amount", "max",
    "--to", w.address,
  ]);
  assertEqual(tx.intent, "aave_withdraw", "intent");
  assertEqual(
    tx.unsigned_tx.to.toLowerCase(),
    AAVE_POOL.toLowerCase(),
    "to should be Aave Pool",
  );

  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    const usdt0After = await readBalance(w, USDT0);
    setDetails({
      usdt0_received: formatUnits(usdt0After - usdt0Before, 6),
      gas_used: result.receipt.gasUsed.toString(),
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Repay USDT0 debt (max)
// ---------------------------------------------------------------------------

test("Aave: re-approve USDT0 for Pool (repay)", async () => {
  // Max-approve is idempotent; helper skips if allowance still sufficient.
  await approveIfNeeded(wallet(), USDT0, AAVE_POOL, "Aave Pool");
  setDetails({ approved: true });
});

test("Aave: repay USDT0 debt (max)", async () => {
  const w = wallet();
  const tx = await buildTx([
    "aave", "repay",
    "--asset", "USDT0",
    "--amount", "max",
    "--on-behalf-of", w.address,
  ]);
  assertEqual(tx.intent, "aave_repay", "intent");
  assertEqual(
    tx.unsigned_tx.to.toLowerCase(),
    AAVE_POOL.toLowerCase(),
    "to should be Aave Pool",
  );

  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    setDetails({
      repaid: "max",
      gas_used: result.receipt.gasUsed.toString(),
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Withdraw supplied WMNT (max) — now that debt is 0
// ---------------------------------------------------------------------------

test("Aave: withdraw supplied WMNT (max)", async () => {
  const w = wallet();
  const wmntBefore = await readBalance(w, WMNT);

  const tx = await buildTx([
    "aave", "withdraw",
    "--asset", "WMNT",
    "--amount", "max",
    "--to", w.address,
  ]);
  assertEqual(tx.intent, "aave_withdraw", "intent");
  assertEqual(
    tx.unsigned_tx.to.toLowerCase(),
    AAVE_POOL.toLowerCase(),
    "to should be Aave Pool",
  );

  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    const wmntAfter = await readBalance(w, WMNT);
    setDetails({
      wmnt_received: formatEther(wmntAfter - wmntBefore),
      gas_used: result.receipt.gasUsed.toString(),
    });
  }
});

// ---------------------------------------------------------------------------
// 8. Verify positions empty
// ---------------------------------------------------------------------------

test("Aave: verify positions empty", async () => {
  const w = wallet();
  if (DRY_RUN) {
    setDetails({ dry_run: true });
    return;
  }
  const res = await runCli(["aave", "positions", "--user", w.address]);
  assertEqual(res.exitCode, 0, "positions exit code");
  assertDefined(res.json, "positions json");

  type Pos = {
    symbol: string;
    supplied: string;
    total_debt: string;
    variable_debt: string;
  };
  const positions: Pos[] = (res.json.positions ?? []) as Pos[];
  const nonZero = positions.filter((p) => {
    const supplied = Number(p.supplied);
    const debt = Number(p.total_debt);
    // A few wei of residual dust is acceptable after max-withdraw / max-repay.
    return supplied > 0.000001 || debt > 0.000001;
  });
  setDetails({
    total_positions: positions.length,
    non_zero_positions: nonZero.map((p) => ({
      symbol: p.symbol,
      supplied: p.supplied,
      debt: p.total_debt,
    })),
  });
  assertEqual(nonZero.length, 0, "residual Aave positions");
});

// Silence unused-import warnings if TS is strict about it.
// (parseUnits is used in the USDT0 swap sanity check; formatEther/formatUnits
// are used throughout. Nothing to silence.)

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runScenario({
  name: "Aave V3 Scenario: supply → borrow → unwind",
  description:
    "Supply WMNT + USDT0, enable WMNT as collateral, borrow USDT0, then fully unwind.",
  livePreview: [
    `0. Cleanup any pre-existing Aave positions (repay debts + withdraw supplies)`,
    `1. Wrap up to ${ENSURE_WMNT} MNT → WMNT (if needed); swap ${SWAP_WMNT_FOR_USDT0} WMNT → USDT0 on Moe (skip if balance ≥ ${SUPPLY_USDT0})`,
    `2. Supply ${SUPPLY_WMNT} WMNT + ${SUPPLY_USDT0} USDT0`,
    `3. Enable WMNT as collateral`,
    `4. Borrow ${BORROW_USDT0} USDT0 (variable rate)`,
    `5. Withdraw supplied USDT0 (max)`,
    `6. Repay USDT0 debt (max)`,
    `7. Withdraw supplied WMNT (max)`,
  ],
});
