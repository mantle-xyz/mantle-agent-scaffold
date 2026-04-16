/**
 * Scenario 2 — Provide and remove liquidity on Merchant Moe and Agni.
 *
 * Moe:   WMNT/USDT (bin_step 15) — 0.1 USDT + ~0.3 WMNT into the active bin.
 * Agni:  WMNT/USDe (fee 2500, tickSpacing 50, pool 0xeafc4d6d4c…) —
 *        0.1 USDe + ~0.3 WMNT, full range.
 *
 * After adding LP on both, we remove 100 %% of each position.
 *
 * Usage:
 *   TEST_PRIVATE_KEY=0x... npm run test:lp          # live on mainnet
 *   TEST_PRIVATE_KEY=0x... npm run test:lp:dry      # dry-run
 */

import { parseEther, parseUnits, formatEther, formatUnits, parseAbi } from "viem";

import { signAndSend } from "./wallet.js";
import { buildTx, runCli } from "./cli.js";
import { test, setDetails } from "./runner.js";
import {
  assertEqual,
  assertDefined,
  assertGreaterThan,
} from "./assert.js";
import {
  DRY_RUN,
  approveIfNeeded,
  readBalance,
  readActiveId,
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

// --- Shared state between add and remove ------------------------------------
let moeActiveId: number | null = null;
let agniTokenId: string | null = null;

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

  // Fetch the current active bin on-chain (hardcoded 8388608 default is almost always wrong).
  moeActiveId = await readActiveId(w, pool.address);
  console.log(`  current activeId: ${moeActiveId}`);

  // On-chain token order for this pool: tokenX=WMNT, tokenY=USDT.
  // Pass amounts accordingly so the tool maps amount_a → amount_x, amount_b → amount_y.
  const tx = await buildTx([
    "lp", "add",
    "--provider", "merchant_moe",
    "--token-a", "WMNT",
    "--token-b", "USDT",
    "--amount-a", MOE_LP_WMNT,
    "--amount-b", MOE_LP_USDT,
    "--recipient", w.address,
    "--bin-step", String(pool.binStep),
    "--active-id", String(moeActiveId),
    "--delta-ids",     "[0]",
    "--distribution-x","[1000000000000000000]",   // 100 % of X into the active bin
    "--distribution-y","[1000000000000000000]",   // 100 % of Y into the active bin
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
      activeId: moeActiveId,
      gas_used: result.receipt.gasUsed.toString(),
    });
  }
});

test("Moe: approve LB Router as share operator", async () => {
  const w = wallet();
  const pool = POOLS.moe_wmnt_usdt;

  // LB shares are ERC-1155-ish; the router needs `isApprovedForAll(owner, router)`
  // before it can burn our bins via removeLiquidity. Passing --owner makes the
  // tool pre-check and short-circuit to approve_skip if already approved.
  const tx = await buildTx([
    "lp", "approve-lb",
    "--pair",     pool.address,
    "--operator", MOE_LB_ROUTER,
    "--owner",    w.address,
  ]);

  if (tx.intent === "approve_skip") {
    console.log("  (LB operator already approved for this pair)");
    setDetails({ skipped: true, reason: "already_approved" });
    return;
  }

  assertEqual(tx.intent, "approve_lb", "intent");
  assertEqual(
    tx.unsigned_tx.to.toLowerCase(),
    pool.address.toLowerCase(),
    "to should be the LB Pair (approveForAll target)",
  );
  assertEqual(tx.unsigned_tx.chainId, CHAIN_ID, "chainId");

  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "approveForAll tx status");
    trackTx(result.hash);
    setDetails({
      pair: pool.address,
      operator: MOE_LB_ROUTER,
      gas_used: result.receipt.gasUsed.toString(),
    });
  }
});

test("Moe: remove liquidity WMNT/USDT", async () => {
  const w = wallet();
  const pool = POOLS.moe_wmnt_usdt;

  if (DRY_RUN) {
    // Dry-run: build the tx shape with a fake 1 LB-token amount just to prove the CLI path.
    const fakeId = moeActiveId ?? 8369901;
    const tx = await buildTx([
      "lp", "remove",
      "--provider", "merchant_moe",
      "--recipient", w.address,
      "--token-a", "WMNT",
      "--token-b", "USDT",
      "--bin-step", String(pool.binStep),
      "--ids",     `[${fakeId}]`,
      "--amounts", "[1]",
    ]);
    assertEqual(tx.intent, "remove_liquidity", "intent");
    setDetails({ dry_run: true });
    await signAndSend(w, tx.unsigned_tx, { dryRun: true });
    return;
  }

  // Live: query our LB-token balance at the active bin (ERC1155 balanceOf).
  const lbPairAbi = parseAbi([
    "function balanceOf(address account, uint256 id) view returns (uint256)",
  ]);
  if (moeActiveId == null) throw new Error("moeActiveId not set — add step didn't run");
  const lbBalance = await w.publicClient.readContract({
    address: pool.address as `0x${string}`,
    abi: lbPairAbi,
    functionName: "balanceOf",
    args: [w.address as `0x${string}`, BigInt(moeActiveId)],
  }) as bigint;

  assertGreaterThan(lbBalance, 0n, "LB-token balance at active bin");

  const tx = await buildTx([
    "lp", "remove",
    "--provider", "merchant_moe",
    "--recipient", w.address,
    "--token-a", "WMNT",
    "--token-b", "USDT",
    "--bin-step", String(pool.binStep),
    "--ids",     `[${moeActiveId}]`,
    "--amounts", `[${lbBalance.toString()}]`,
  ]);

  const result = await signAndSend(w, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    setDetails({
      activeId: moeActiveId,
      lb_balance_removed: lbBalance.toString(),
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

test("Agni: locate new LP position (fetch token_id)", async () => {
  const w = wallet();

  // Query positions, pick the newest WMNT/USDe position.
  const res = await runCli([
    "lp", "positions",
    "--owner", w.address,
    "--provider", "agni",
  ]);
  assertEqual(res.exitCode, 0, "positions exit code");
  assertDefined(res.json, "positions json");

  type Pos = {
    token_id: string;
    fee: number;
    liquidity: string;
    token0?: { symbol?: string; address?: string };
    token1?: { symbol?: string; address?: string };
  };
  const positions: Pos[] = (res.json.positions ?? []) as Pos[];
  // Match by fee tier + symbol set, prefer newest (highest token_id).
  const matches = positions.filter((p) => {
    if (p.fee !== POOLS.agni_wmnt_usde.feeTier) return false;
    const symbols = [p.token0?.symbol, p.token1?.symbol];
    return symbols.includes("WMNT") && symbols.includes("USDe");
  });

  if (matches.length === 0) {
    if (DRY_RUN) {
      // No position exists yet (add was not broadcast). Use any existing position as a stand-in
      // just to prove the remove call path builds correctly.
      if (positions.length === 0) {
        agniTokenId = null;
        setDetails({ dry_run: true, note: "no existing positions, remove step will be skipped" });
        return;
      }
      agniTokenId = positions[0].token_id;
      setDetails({
        dry_run: true,
        stand_in_token_id: agniTokenId,
        note: "using existing position as stand-in for dry-run",
      });
      return;
    }
    throw new Error("No matching WMNT/USDe Agni position found after add");
  }

  matches.sort((a, b) => Number(BigInt(b.token_id) - BigInt(a.token_id)));
  agniTokenId = matches[0].token_id;
  setDetails({
    token_id: agniTokenId,
    liquidity: matches[0].liquidity,
    total_positions: positions.length,
  });
});

test("Agni: remove liquidity (100%)", async () => {
  const w = wallet();
  if (agniTokenId == null) {
    if (DRY_RUN) {
      console.log("  (DRY_RUN: no token_id available — remove step skipped)");
      setDetails({ dry_run: true, skipped: true });
      return;
    }
    throw new Error("agniTokenId not set");
  }

  const tx = await buildTx([
    "lp", "remove",
    "--provider", "agni",
    "--recipient", w.address,
    "--token-id", agniTokenId,
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
      token_id: agniTokenId,
      gas_used: result.receipt.gasUsed.toString(),
    });
  }
});

// Silence unused-import warnings if TS complains.
void parseEther;
void parseUnits;
void formatEther;
void formatUnits;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runScenario({
  name: "LP Scenario: Moe WMNT/USDT + Agni WMNT/USDe",
  description: "Add liquidity then fully remove on both DEXes.",
  livePreview: [
    `1. Moe  WMNT/USDT (binStep 15): approve tokens, add ${MOE_LP_WMNT} WMNT + ${MOE_LP_USDT} USDT, approve LB router as share operator, remove 100%`,
    `2. Agni WMNT/USDe (fee 2500, spacing 50): approve, add ${AGNI_LP_WMNT} WMNT + ${AGNI_LP_USDe} USDe (full range), remove 100%`,
  ],
});
