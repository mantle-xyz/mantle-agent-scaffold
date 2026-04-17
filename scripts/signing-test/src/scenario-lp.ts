/**
 * Scenario 2 — Provide and remove liquidity on Merchant Moe and Agni.
 *
 * Simulates an external agent (Privy wallet + mantle-cli) adding LP on each
 * DEX and fully removing it afterwards. Uses only business-level parameters
 * and queries `lp positions` via CLI to discover position identifiers for
 * removal, mirroring how an agent would naturally drive this flow.
 *
 * Step 0 (cleanup): before the actual flow, we list all existing LP positions
 * on both Moe (LB) and Agni (V3) and remove any that have non-zero liquidity.
 * This makes the test idempotent — a prior crashed run won't pollute this run.
 * Skipped in DRY_RUN.
 *
 * Step 1 (token prep): wrap MNT → WMNT if we don't have enough, then swap
 * WMNT → USDT and WMNT → USDe on Moe so we actually have the stable-side
 * tokens needed for the LP adds. Each step skips when balance is already
 * sufficient, so repeated runs don't over-acquire.
 *
 * Moe:   WMNT/USDT (binStep 15) — 0.1 USDT + ~0.3 WMNT into the active bin.
 * Agni:  WMNT/USDe (feeTier 2500, tickSpacing 50) — 0.1 USDe + ~0.3 WMNT, full range.
 *
 * After adding LP on both, we remove 100%% of each position.
 *
 * Usage:
 *   TEST_PRIVATE_KEY=0x... npm run test:lp          # live on mainnet
 *   TEST_PRIVATE_KEY=0x... npm run test:lp:dry      # dry-run
 */

import { parseEther, parseUnits, formatEther, formatUnits } from "viem";

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
  USDT,
  USDe,
  POOLS,
  AGNI_POSITION_MANAGER,
  MOE_LB_ROUTER,
  CHAIN_ID,
} from "./constants.js";

// --- LP amounts -------------------------------------------------------------
const MOE_LP_WMNT  = "0.3";
const MOE_LP_USDT  = "0.1";
const AGNI_LP_WMNT = "0.3";
const AGNI_LP_USDe = "0.1";

// --- Token prep amounts -----------------------------------------------------
// We need enough WMNT to cover both LP adds (0.3 + 0.3 = 0.6) plus the two
// WMNT→stable swaps that top up USDT/USDe balances (0.3 + 0.3 = 0.6). 1.5 WMNT
// target leaves ~0.3 headroom. Keep this low enough that a freshly-funded test
// wallet (modest MNT balance) can wrap up to this level without running out —
// `value + gas > MNT balance` will revert the wrap tx.
const ENSURE_WMNT        = "1.5";
const SWAP_WMNT_FOR_USDT = "0.3";
const SWAP_WMNT_FOR_USDe = "0.3";

// ---------------------------------------------------------------------------
// Shared LP position types (used by both cleanup and per-DEX remove tests)
// ---------------------------------------------------------------------------

type LBBin = {
  bin_id: number | string;
  balance_raw: string;
};
type LBPosition = {
  pair_address: string;
  token_x?: { address: string; symbol?: string };
  token_y?: { address: string; symbol?: string };
  bin_step: number | string;
  bins: LBBin[];
};
type V3Position = {
  provider: string;
  token_id: string;
  token0: { address: string; symbol?: string };
  token1: { address: string; symbol?: string };
  fee: number;
  liquidity: string;
};

// ---------------------------------------------------------------------------
// 0. Pre-test cleanup: remove any pre-existing LP positions on Moe + Agni so
//    the test starts from a clean slate. Skipped in DRY_RUN since cleanup
//    must actually broadcast txs to be useful.
// ---------------------------------------------------------------------------

test("LP: cleanup any pre-existing positions (reset to clean state)", async () => {
  const w = wallet();
  if (DRY_RUN) {
    setDetails({ skipped: true, reason: "dry_run" });
    return;
  }

  const fetchMoe = async (): Promise<LBPosition[]> => {
    const res = await runCli([
      "lp", "positions",
      "--owner", w.address,
      "--provider", "merchant_moe",
    ]);
    assertEqual(res.exitCode, 0, "moe lp positions exit code");
    assertDefined(res.json, "moe positions json");
    const errors = (res.json.errors ?? []) as unknown[];
    if (errors.length > 0) {
      throw new Error(`moe lp positions scan error: ${JSON.stringify(errors)}`);
    }
    const warnings = (res.json.warnings ?? []) as unknown[];
    if (warnings.length > 0) console.warn("  Moe scan warnings:", warnings);
    return (res.json.positions ?? []) as LBPosition[];
  };

  const fetchAgni = async (): Promise<V3Position[]> => {
    const res = await runCli([
      "lp", "positions",
      "--owner", w.address,
      "--provider", "agni",
    ]);
    assertEqual(res.exitCode, 0, "agni lp positions exit code");
    assertDefined(res.json, "agni positions json");
    const errors = (res.json.errors ?? []) as unknown[];
    if (errors.length > 0) {
      throw new Error(`agni lp positions scan error: ${JSON.stringify(errors)}`);
    }
    const warnings = (res.json.warnings ?? []) as unknown[];
    if (warnings.length > 0) console.warn("  Agni scan warnings:", warnings);
    return (res.json.positions ?? []) as V3Position[];
  };

  const moeBefore = await fetchMoe();
  const agniBefore = await fetchAgni();

  // Filter to non-zero positions only. For LB, "non-zero" means at least one
  // bin has balance > 0. For V3, liquidity > 0.
  const moeNonEmpty = moeBefore.filter((p) =>
    (p.bins ?? []).some((b) => {
      try { return BigInt(b.balance_raw) > 0n; } catch { return false; }
    }),
  );
  const agniNonEmpty = agniBefore.filter((p) => {
    try { return BigInt(p.liquidity) > 0n; } catch { return false; }
  });

  if (moeNonEmpty.length === 0 && agniNonEmpty.length === 0) {
    console.log("  (no existing LP positions — already clean)");
    setDetails({ cleanup_needed: false });
    return;
  }

  console.log(
    `  Found ${moeNonEmpty.length} Moe + ${agniNonEmpty.length} Agni position(s); removing...`,
  );

  // --- Remove Moe LB positions ---------------------------------------------
  // For each non-empty position we just call `lp remove --percentage 100` and
  // let the CLI read bin balances on-chain itself. No need to extract bins /
  // construct --ids / --amounts arrays manually — that's exactly what the CLI's
  // percentage mode does internally.
  for (const pos of moeNonEmpty) {
    const symX = pos.token_x?.symbol ?? pos.token_x?.address;
    const symY = pos.token_y?.symbol ?? pos.token_y?.address;
    if (!symX || !symY) {
      throw new Error(
        `cannot remove Moe position at ${pos.pair_address}: missing token symbol/address`,
      );
    }

    console.log(
      `  Removing Moe ${symX}/${symY} (binStep ${pos.bin_step}, 100%)...`,
    );

    const tx = await buildTx([
      "lp", "remove",
      "--provider", "merchant_moe",
      "--recipient", w.address,
      "--token-a", symX,
      "--token-b", symY,
      "--bin-step", String(pos.bin_step),
      "--percentage", "100",
    ]);
    assertEqual(tx.intent, "remove_liquidity", "intent");

    const result = await signAndSend(w, tx.unsigned_tx, { dryRun: false });
    if (result) {
      assertEqual(
        result.receipt.status,
        "success",
        `remove Moe ${symX}/${symY} status`,
      );
      trackTx(result.hash);
    }
  }

  // --- Remove Agni V3 positions --------------------------------------------
  for (const pos of agniNonEmpty) {
    const sym0 = pos.token0?.symbol ?? pos.token0?.address ?? "?";
    const sym1 = pos.token1?.symbol ?? pos.token1?.address ?? "?";
    console.log(
      `  Removing Agni ${sym0}/${sym1} (token_id=${pos.token_id}, fee ${pos.fee})...`,
    );

    const tx = await buildTx([
      "lp", "remove",
      "--provider", "agni",
      "--recipient", w.address,
      "--token-id", pos.token_id,
      "--percentage", "100",
    ]);
    assertEqual(tx.intent, "remove_liquidity", "intent");

    const result = await signAndSend(w, tx.unsigned_tx, { dryRun: false });
    if (result) {
      assertEqual(
        result.receipt.status,
        "success",
        `remove Agni #${pos.token_id} status`,
      );
      trackTx(result.hash);
    }
  }

  // --- Verify clean ---------------------------------------------------------
  const moeAfter = await fetchMoe();
  const agniAfter = await fetchAgni();
  const moeRemaining = moeAfter.filter((p) =>
    (p.bins ?? []).some((b) => {
      try { return BigInt(b.balance_raw) > 0n; } catch { return false; }
    }),
  );
  const agniRemaining = agniAfter.filter((p) => {
    try { return BigInt(p.liquidity) > 0n; } catch { return false; }
  });

  setDetails({
    cleanup_needed: true,
    moe_removed: moeNonEmpty.length,
    agni_removed: agniNonEmpty.length,
    moe_remaining: moeRemaining.length,
    agni_remaining: agniRemaining.length,
  });

  if (moeRemaining.length > 0 || agniRemaining.length > 0) {
    throw new Error(
      `LP cleanup failed — ${moeRemaining.length} Moe + ${agniRemaining.length} Agni position(s) still non-empty`,
    );
  }
});

// ---------------------------------------------------------------------------
// Setup: zero out all relevant allowances so every approve step in this run
// is exercised (no "already sufficient" skips from a previous run).
// ---------------------------------------------------------------------------

test("Setup: reset WMNT/USDT/USDe allowances for Moe + Agni to 0", async () => {
  const w = wallet();
  await resetAllowance(w, WMNT, MOE_LB_ROUTER,         "Moe LB Router");
  await resetAllowance(w, USDT, MOE_LB_ROUTER,         "Moe LB Router");
  await resetAllowance(w, WMNT, AGNI_POSITION_MANAGER, "Agni PositionManager");
  await resetAllowance(w, USDe, AGNI_POSITION_MANAGER, "Agni PositionManager");
  setDetails({ allowances_reset: true });
});

// ---------------------------------------------------------------------------
// Token prep: ensure we have enough WMNT + USDT + USDe for the LP adds.
// Cleanup above may have removed pre-existing positions, leaving us with zero
// USDT/USDe. Also a fresh wallet won't have any stable balances. Acquire them
// via WMNT→stable swaps on Moe (skip each step if balance is already enough).
// ---------------------------------------------------------------------------

test("Ensure WMNT balance for LP + stable swaps (wrap MNT if needed)", async () => {
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

test(`Acquire USDT: swap ${SWAP_WMNT_FOR_USDT} WMNT → USDT on Moe (skip if balance sufficient)`, async () => {
  const w = wallet();

  if (!DRY_RUN) {
    const usdtBalance = await readBalance(w, USDT);
    if (usdtBalance >= parseUnits(MOE_LP_USDT, 6)) {
      console.log(`  (already have ${formatUnits(usdtBalance, 6)} USDT ≥ ${MOE_LP_USDT}, skipping)`);
      setDetails({ skipped: true, usdt_balance: formatUnits(usdtBalance, 6) });
      return;
    }
  }

  // Approve WMNT for LB Router before swapping (no-op if already approved).
  await approveIfNeeded(w, WMNT, MOE_LB_ROUTER, "Moe LB Router");

  const quote = await runCli([
    "defi", "swap-quote",
    "--in", "WMNT", "--out", "USDT",
    "--amount", SWAP_WMNT_FOR_USDT,
    "--provider", "merchant_moe",
  ]);
  assertEqual(quote.exitCode, 0, "quote exit code");
  const minOut = quote.json?.minimum_out_raw;
  assertDefined(minOut, "minimum_out_raw");

  const before = DRY_RUN ? 0n : await readBalance(w, USDT);
  const tx = await buildTx([
    "swap", "build-swap",
    "--provider", "merchant_moe",
    "--in", "WMNT", "--out", "USDT",
    "--amount", SWAP_WMNT_FOR_USDT,
    "--recipient", w.address,
    "--amount-out-min", minOut,
  ]);
  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    const after = await readBalance(w, USDT);
    const received = after - before;
    setDetails({
      usdt_received: formatUnits(received, 6),
      quote_minimum: quote.json?.minimum_out,
    });
    // Sanity check: make sure the swap actually gave us enough USDT for LP add.
    if (after < parseUnits(MOE_LP_USDT, 6)) {
      throw new Error(
        `USDT swap completed but balance ${formatUnits(after, 6)} < required ${MOE_LP_USDT}`,
      );
    }
  }
});

test(`Acquire USDe: swap ${SWAP_WMNT_FOR_USDe} WMNT → USDe on Moe (skip if balance sufficient)`, async () => {
  const w = wallet();

  if (!DRY_RUN) {
    const usdeBalance = await readBalance(w, USDe);
    if (usdeBalance >= parseEther(AGNI_LP_USDe)) {
      console.log(`  (already have ${formatEther(usdeBalance)} USDe ≥ ${AGNI_LP_USDe}, skipping)`);
      setDetails({ skipped: true, usde_balance: formatEther(usdeBalance) });
      return;
    }
  }

  // WMNT approval for LB Router may already exist from the USDT swap above;
  // approveIfNeeded is a no-op in that case.
  await approveIfNeeded(w, WMNT, MOE_LB_ROUTER, "Moe LB Router");

  const quote = await runCli([
    "defi", "swap-quote",
    "--in", "WMNT", "--out", "USDe",
    "--amount", SWAP_WMNT_FOR_USDe,
    "--provider", "merchant_moe",
  ]);
  assertEqual(quote.exitCode, 0, "quote exit code");
  const minOut = quote.json?.minimum_out_raw;
  assertDefined(minOut, "minimum_out_raw");

  const before = DRY_RUN ? 0n : await readBalance(w, USDe);
  const tx = await buildTx([
    "swap", "build-swap",
    "--provider", "merchant_moe",
    "--in", "WMNT", "--out", "USDe",
    "--amount", SWAP_WMNT_FOR_USDe,
    "--recipient", w.address,
    "--amount-out-min", minOut,
  ]);
  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    const after = await readBalance(w, USDe);
    const received = after - before;
    setDetails({
      usde_received: formatEther(received),
      quote_minimum: quote.json?.minimum_out,
    });
    // Sanity check: enough USDe for Agni LP add.
    if (after < parseEther(AGNI_LP_USDe)) {
      throw new Error(
        `USDe swap completed but balance ${formatEther(after)} < required ${AGNI_LP_USDe}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Moe LP: approve → add → remove
// ---------------------------------------------------------------------------

test("Moe: approve WMNT + USDT for LB Router", async () => {
  const w = wallet();
  await approveIfNeeded(w, WMNT, MOE_LB_ROUTER, "Moe LB Router");
  await approveIfNeeded(w, USDT, MOE_LB_ROUTER, "Moe LB Router");
  setDetails({ approved: true });
});

test("Moe: add liquidity WMNT/USDT (active bin)", async () => {
  const w = wallet();
  const pool = POOLS.moe_wmnt_usdt;

  // Minimal business params only — CLI should resolve active_id, delta_ids,
  // and distribution internally (default behaviour = single bin at active id).
  const tx = await buildTx([
    "lp", "add",
    "--provider", "merchant_moe",
    "--token-a", "WMNT",
    "--token-b", "USDT",
    "--amount-a", MOE_LP_WMNT,
    "--amount-b", MOE_LP_USDT,
    "--recipient", w.address,
    "--bin-step", String(pool.binStep),
  ]);

  assertEqual(tx.intent, "add_liquidity", "intent");
  assertEqual(tx.unsigned_tx.chainId, CHAIN_ID, "chainId");
  assertEqual(
    tx.unsigned_tx.to.toLowerCase(),
    MOE_LB_ROUTER.toLowerCase(),
    "to should be Moe LB Router",
  );

  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    setDetails({
      gas_used: result.receipt.gasUsed.toString(),
    });
  }
});

test("Moe: remove liquidity WMNT/USDT", async () => {
  const w = wallet();
  const pool = POOLS.moe_wmnt_usdt;

  // Sanity-check that a position exists before asking the CLI to remove it
  // (mainly to give a nicer failure mode in DRY_RUN, where the add was never
  // broadcast). In LIVE mode we just delegate to `lp remove --percentage 100`,
  // which reads the bin balances on-chain itself.
  if (DRY_RUN) {
    const res = await runCli([
      "lp", "positions",
      "--owner", w.address,
      "--provider", "merchant_moe",
    ]);
    assertEqual(res.exitCode, 0, "lp positions exit code");
    assertDefined(res.json, "positions json");
    const positions = (res.json.positions ?? []) as LBPosition[];
    const moePos = positions.find((p) =>
      Number(p.bin_step) === pool.binStep &&
      p.pair_address.toLowerCase() === pool.address.toLowerCase(),
    );
    if (!moePos) {
      console.log("  (DRY_RUN: no on-chain position to remove — add was never broadcast)");
      setDetails({ dry_run: true, skipped: true });
      return;
    }
  }

  const tx = await buildTx([
    "lp", "remove",
    "--provider", "merchant_moe",
    "--recipient", w.address,
    "--token-a", "WMNT",
    "--token-b", "USDT",
    "--bin-step", String(pool.binStep),
    "--percentage", "100",
  ]);
  assertEqual(tx.intent, "remove_liquidity", "intent");

  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    setDetails({
      gas_used: result.receipt.gasUsed.toString(),
    });
  }
});

// ---------------------------------------------------------------------------
// Agni LP: approve → add → remove
// ---------------------------------------------------------------------------

test("Agni: approve WMNT + USDe for PositionManager", async () => {
  const w = wallet();
  await approveIfNeeded(w, WMNT, AGNI_POSITION_MANAGER, "Agni PositionManager");
  await approveIfNeeded(w, USDe, AGNI_POSITION_MANAGER, "Agni PositionManager");
  setDetails({ approved: true });
});

test("Agni: add liquidity WMNT/USDe (full range)", async () => {
  const w = wallet();
  const pool = POOLS.agni_wmnt_usde;

  // Business-level params: tokens, amounts, fee tier, and an explicit tick
  // range. Tick bounds are pool-specific (tickSpacing-aligned), so an agent
  // would compute full-range from the pool's tickSpacing.
  const tx = await buildTx([
    "lp", "add",
    "--provider", "agni",
    "--token-a", "WMNT",
    "--token-b", "USDe",
    "--amount-a", AGNI_LP_WMNT,
    "--amount-b", AGNI_LP_USDe,
    "--recipient", w.address,
    "--fee-tier",   String(pool.feeTier),
    "--tick-lower", String(-pool.fullRangeTick),
    "--tick-upper", String(pool.fullRangeTick),
  ]);

  assertEqual(tx.intent, "add_liquidity", "intent");
  assertEqual(
    tx.unsigned_tx.to.toLowerCase(),
    AGNI_POSITION_MANAGER.toLowerCase(),
    "to should be Agni PositionManager",
  );

  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    setDetails({
      feeTier: pool.feeTier,
      tick_range: `[${-pool.fullRangeTick}, ${pool.fullRangeTick}]`,
      gas_used: result.receipt.gasUsed.toString(),
    });
  }
});

test("Agni: remove liquidity (100%)", async () => {
  const w = wallet();

  // Natural agent flow: query our V3 positions on Agni, find the WMNT/USDe
  // one (matched by fee tier), and feed its token_id into `lp remove`.
  const res = await runCli([
    "lp", "positions",
    "--owner", w.address,
    "--provider", "agni",
  ]);
  assertEqual(res.exitCode, 0, "lp positions exit code");
  assertDefined(res.json, "positions json");
  const scanErrors = (res.json.errors ?? []) as unknown[];
  if (scanErrors.length > 0) {
    throw new Error(`agni lp positions scan error: ${JSON.stringify(scanErrors)}`);
  }
  const scanWarnings = (res.json.warnings ?? []) as unknown[];
  if (scanWarnings.length > 0) console.warn("  Agni scan warnings:", scanWarnings);

  const positions = (res.json.positions ?? []) as V3Position[];
  const agniPos = positions.find((p) =>
    p.provider === "agni" &&
    Number(p.fee) === POOLS.agni_wmnt_usde.feeTier,
  );
  if (!agniPos) {
    if (DRY_RUN) {
      console.log("  (DRY_RUN: no on-chain position to remove — add was never broadcast)");
      setDetails({ dry_run: true, skipped: true });
      return;
    }
    assertDefined(agniPos, "agni WMNT/USDe position");
  }

  const tx = await buildTx([
    "lp", "remove",
    "--provider", "agni",
    "--recipient", w.address,
    "--token-id", agniPos!.token_id,
    "--percentage", "100",
  ]);

  // V3 remove uses multicall on PositionManager.
  assertEqual(
    tx.unsigned_tx.to.toLowerCase(),
    AGNI_POSITION_MANAGER.toLowerCase(),
    "to should be Agni PositionManager",
  );

  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    setDetails({
      token_id: agniPos!.token_id,
      gas_used: result.receipt.gasUsed.toString(),
    });
  }
});

// ---------------------------------------------------------------------------
// Teardown: restore wallet to its pre-scenario state.
//
// The LP scenario acquires USDT and USDe by swapping WMNT (token prep), then
// fully removes the LP positions — but the stables end up back in the wallet,
// not re-converted to WMNT. We swap them all back here so the wallet exits with
// roughly the same WMNT it had at the start (minus swap slippage and gas).
// Then every allowance is zeroed out.
// ---------------------------------------------------------------------------

test("Teardown: swap all USDT back to WMNT on Moe", async () => {
  const w = wallet();
  if (DRY_RUN) {
    setDetails({ skipped: true, reason: "dry_run" });
    return;
  }

  const usdtBalance = await readBalance(w, USDT);
  const MIN_SWAP = parseUnits("0.001", 6); // skip dust < 0.001 USDT
  if (usdtBalance < MIN_SWAP) {
    console.log(
      `  (USDT balance ${formatUnits(usdtBalance, 6)} < 0.001, nothing to swap back)`,
    );
    setDetails({ skipped: true, usdt_balance: formatUnits(usdtBalance, 6) });
    return;
  }

  const swapAmount = formatUnits(usdtBalance, 6);
  console.log(`  Swapping ${swapAmount} USDT → WMNT on Moe...`);

  const quote = await runCli([
    "defi", "swap-quote",
    "--in", "USDT", "--out", "WMNT",
    "--amount", swapAmount,
    "--provider", "merchant_moe",
  ]);
  assertEqual(quote.exitCode, 0, "USDT→WMNT quote exit code");
  const minOut = quote.json?.minimum_out_raw;
  assertDefined(minOut, "minimum_out_raw for USDT→WMNT");

  // USDT may still be approved from the Moe LP add; approveIfNeeded is a no-op
  // if the allowance is still sufficient. The final teardown step resets it.
  await approveIfNeeded(w, USDT, MOE_LB_ROUTER, "Moe LB Router");

  const wmntBefore = await readBalance(w, WMNT);
  const tx = await buildTx([
    "swap", "build-swap",
    "--provider", "merchant_moe",
    "--in", "USDT", "--out", "WMNT",
    "--amount", swapAmount,
    "--recipient", w.address,
    "--amount-out-min", minOut,
  ]);
  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: false });
  if (result) {
    assertEqual(result.receipt.status, "success", "USDT→WMNT swap status");
    trackTx(result.hash);
    const wmntAfter = await readBalance(w, WMNT);
    setDetails({
      usdt_swapped: swapAmount,
      wmnt_received: formatEther(wmntAfter - wmntBefore),
    });
  }
});

test("Teardown: swap all USDe back to WMNT on Moe", async () => {
  const w = wallet();
  if (DRY_RUN) {
    setDetails({ skipped: true, reason: "dry_run" });
    return;
  }

  const usdeBalance = await readBalance(w, USDe);
  const MIN_SWAP = parseEther("0.001"); // skip dust < 0.001 USDe
  if (usdeBalance < MIN_SWAP) {
    console.log(
      `  (USDe balance ${formatEther(usdeBalance)} < 0.001, nothing to swap back)`,
    );
    setDetails({ skipped: true, usde_balance: formatEther(usdeBalance) });
    return;
  }

  const swapAmount = formatEther(usdeBalance);
  console.log(`  Swapping ${swapAmount} USDe → WMNT on Moe...`);

  const quote = await runCli([
    "defi", "swap-quote",
    "--in", "USDe", "--out", "WMNT",
    "--amount", swapAmount,
    "--provider", "merchant_moe",
  ]);
  assertEqual(quote.exitCode, 0, "USDe→WMNT quote exit code");
  const minOut = quote.json?.minimum_out_raw;
  assertDefined(minOut, "minimum_out_raw for USDe→WMNT");

  // USDe was not previously approved for Moe (only for Agni PositionManager).
  // approveIfNeeded will set a fresh max allowance; the final step resets it.
  await approveIfNeeded(w, USDe, MOE_LB_ROUTER, "Moe LB Router");

  const wmntBefore = await readBalance(w, WMNT);
  const tx = await buildTx([
    "swap", "build-swap",
    "--provider", "merchant_moe",
    "--in", "USDe", "--out", "WMNT",
    "--amount", swapAmount,
    "--recipient", w.address,
    "--amount-out-min", minOut,
  ]);
  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: false });
  if (result) {
    assertEqual(result.receipt.status, "success", "USDe→WMNT swap status");
    trackTx(result.hash);
    const wmntAfter = await readBalance(w, WMNT);
    setDetails({
      usde_swapped: swapAmount,
      wmnt_received: formatEther(wmntAfter - wmntBefore),
    });
  }
});

test("Teardown: reset all token allowances to 0", async () => {
  const w = wallet();
  // Reset every pair touched during setup, the scenario, and the teardown swaps.
  await resetAllowance(w, WMNT, MOE_LB_ROUTER,         "Moe LB Router");
  await resetAllowance(w, USDT, MOE_LB_ROUTER,         "Moe LB Router");
  await resetAllowance(w, USDe, MOE_LB_ROUTER,         "Moe LB Router"); // set by teardown swap
  await resetAllowance(w, WMNT, AGNI_POSITION_MANAGER, "Agni PositionManager");
  await resetAllowance(w, USDe, AGNI_POSITION_MANAGER, "Agni PositionManager");
  setDetails({ allowances_reset: true });
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runScenario({
  name: "LP Scenario: Moe WMNT/USDT + Agni WMNT/USDe",
  description: "Add liquidity then fully remove on both DEXes.",
  livePreview: [
    `0. Cleanup any pre-existing LP positions on Moe + Agni`,
    `1. Prep: wrap up to ${ENSURE_WMNT} MNT → WMNT, swap WMNT → USDT (${SWAP_WMNT_FOR_USDT}) + USDe (${SWAP_WMNT_FOR_USDe}) on Moe`,
    `2. Moe  WMNT/USDT (binStep 15): approve, add ${MOE_LP_WMNT} WMNT + ${MOE_LP_USDT} USDT, remove 100%`,
    `3. Agni WMNT/USDe (fee 2500, spacing 50): approve, add ${AGNI_LP_WMNT} WMNT + ${AGNI_LP_USDe} USDe (full range), remove 100%`,
  ],
});
