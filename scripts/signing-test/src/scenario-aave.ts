/**
 * Scenario 3 — Aave V3 lending roundtrip on Mantle.
 *
 * Flow:
 *   1. Approve WMNT  → Aave Pool,  supply 0.5 WMNT
 *   2. Approve USDT0 → Aave Pool,  supply 0.5 USDT0
 *   3. Enable WMNT as collateral (setUserUseReserveAsCollateral)
 *   4. Borrow 0.05 USDT0 (variable rate)
 *   5. Withdraw the supplied USDT0 (max)
 *   6. Repay the USDT0 debt (max) — approves USDT0 again since amount > prior allowance may be needed
 *   7. Withdraw the supplied WMNT (max)
 *   8. Verify positions are empty
 *
 * Usage:
 *   TEST_PRIVATE_KEY=0x... npm run test:aave          # live on mainnet
 *   TEST_PRIVATE_KEY=0x... npm run test:aave:dry      # dry-run
 */

import { formatEther, formatUnits, parseUnits } from "viem";

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
  CHAIN_ID,
} from "./constants.js";

// --- Amounts ----------------------------------------------------------------
const SUPPLY_WMNT  = "0.5";
const SUPPLY_USDT0 = "0.5";
const BORROW_USDT0 = "0.05";

// ---------------------------------------------------------------------------
// 1–2. Approve + supply WMNT, USDT0
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
  // --user triggers a preflight check that requires an existing aToken balance.
  // In dry-run the supply wasn't actually broadcast, so the preflight would fail.
  // Only pass --user when executing live.
  const args = [
    "aave", "set-collateral",
    "--asset", "WMNT",
  ];
  if (!DRY_RUN) {
    args.push("--user", w.address);
  }
  const tx = await buildTx(args);
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
void parseUnits;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runScenario({
  name: "Aave V3 Scenario: supply → borrow → unwind",
  description:
    "Supply WMNT + USDT0, enable WMNT as collateral, borrow USDT0, then fully unwind.",
  livePreview: [
    `1. Supply ${SUPPLY_WMNT} WMNT + ${SUPPLY_USDT0} USDT0`,
    `2. Enable WMNT as collateral`,
    `3. Borrow ${BORROW_USDT0} USDT0 (variable rate)`,
    `4. Withdraw supplied USDT0 (max)`,
    `5. Repay USDT0 debt (max)`,
    `6. Withdraw supplied WMNT (max)`,
  ],
});
