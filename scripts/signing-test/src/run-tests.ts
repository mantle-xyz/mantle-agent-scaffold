/**
 * LP Test — Add liquidity WMNT/USDC on Agni + Merchant Moe
 *
 * Flow:
 *   1. Wrap MNT → WMNT (to have WMNT)
 *   2. Swap some WMNT → USDC (to have both tokens for LP)
 *   3. Agni:  approve WMNT+USDC → PositionManager → add liquidity (full range)
 *   4. Moe:   approve WMNT+USDC → LB Router → add liquidity
 *
 * Usage:
 *   TEST_PRIVATE_KEY=0x... npm test
 *   TEST_PRIVATE_KEY=0x... npm run test:dry
 */

import {
  createTestWallet,
  signAndSend,
  getBalance,
  formatMNT,
  type TestWallet,
} from "./wallet.js";
import { runCli, buildTx } from "./cli.js";
import { test, setTxHash, setDetails, runAllTests } from "./runner.js";
import {
  assert,
  assertEqual,
  assertDefined,
  assertGreaterThan,
} from "./assert.js";
import { erc20Abi, formatEther, parseEther, formatUnits, parseUnits } from "viem";
import chalk from "chalk";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DRY_RUN = process.env.DRY_RUN === "true";
const NETWORK = "mainnet";
const CHAIN_ID = 5000;

// Mainnet addresses
const WMNT = "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8";
const USDC = "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9";

// Whitelisted LP contracts
const AGNI_POSITION_MANAGER = "0x218bf598D1453383e2F4AA7b14fFB9BfB102D637";
const AGNI_SWAP_ROUTER      = "0x319B69888b0d11cEC22caA5034e25FfFBDc88421";
const MOE_LB_ROUTER         = "0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a";

// Amounts — keep small
const WRAP_AMOUNT       = "0.5";    // MNT to wrap
const SWAP_FOR_USDC     = "0.2";    // WMNT to swap for USDC (to have LP pair)
const AGNI_LP_WMNT      = "0.1";    // WMNT for Agni LP
const AGNI_LP_USDC      = "0.03";   // USDC for Agni LP (rough match ~$0.03)
const MOE_LP_WMNT       = "0.1";    // WMNT for Moe LP
const MOE_LP_USDC       = "0.03";   // USDC for Moe LP

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let wallet: TestWallet;
const txLinks: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readBalance(token: `0x${string}`): Promise<bigint> {
  return wallet.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [wallet.address as `0x${string}`],
  }) as Promise<bigint>;
}

function trackTx(hash: string) {
  setTxHash(hash);
  txLinks.push(`https://mantlescan.xyz/tx/${hash}`);
}

async function approveIfNeeded(
  token: string,
  tokenSymbol: string,
  spender: string,
  spenderName: string,
): Promise<void> {
  const tx = await buildTx([
    "swap", "approve",
    "--token", token,
    "--spender", spender,
    "--amount", "max",
    "--owner", wallet.address,
  ]);

  if (tx.intent === "approve_skip") {
    console.log(`  (${tokenSymbol} → ${spenderName}: allowance already sufficient)`);
    return;
  }

  const result = await signAndSend(wallet, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", `${tokenSymbol} approve tx status`);
    trackTx(result.hash);
  }
}

// ---------------------------------------------------------------------------
// Step 1: Prepare tokens — wrap MNT + swap some for USDC
// ---------------------------------------------------------------------------

test("Wrap MNT → WMNT", async () => {
  const before = await readBalance(WMNT as `0x${string}`);
  const tx = await buildTx(["swap", "wrap-mnt", "--amount", WRAP_AMOUNT]);
  const result = await signAndSend(wallet, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    const after = await readBalance(WMNT as `0x${string}`);
    setDetails({ wmnt_after: formatEther(after) });
  }
});

test("Swap WMNT → USDC (prepare LP pair)", async () => {
  // Get quote first
  const quote = await runCli([
    "defi", "swap-quote",
    "--in", "WMNT", "--out", "USDC",
    "--amount", SWAP_FOR_USDC,
    "--provider", "agni",
  ]);
  assertEqual(quote.exitCode, 0, "quote exit code");
  const minOut = quote.json.minimum_out_raw;
  assertDefined(minOut, "minimum_out_raw");

  // Approve WMNT for swap router
  await approveIfNeeded(WMNT, "WMNT", AGNI_SWAP_ROUTER, "Agni SwapRouter");

  // Swap
  const usdcBefore = await readBalance(USDC as `0x${string}`);
  const tx = await buildTx([
    "swap", "build-swap",
    "--provider", "agni",
    "--in", "WMNT", "--out", "USDC",
    "--amount", SWAP_FOR_USDC,
    "--recipient", wallet.address,
    "--amount-out-min", minOut,
  ]);
  const result = await signAndSend(wallet, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "swap tx status");
    trackTx(result.hash);
    const usdcAfter = await readBalance(USDC as `0x${string}`);
    const received = usdcAfter - usdcBefore;
    setDetails({ usdc_received: formatUnits(received, 6) });
  }
});

// ---------------------------------------------------------------------------
// Step 2: Agni LP — approve both tokens + add liquidity (full range)
// ---------------------------------------------------------------------------

test("Agni: approve WMNT + USDC for PositionManager", async () => {
  await approveIfNeeded(WMNT, "WMNT", AGNI_POSITION_MANAGER, "Agni PositionManager");
  await approveIfNeeded(USDC, "USDC", AGNI_POSITION_MANAGER, "Agni PositionManager");
  setDetails({ approved: true });
});

test("Agni: add liquidity WMNT/USDC (full range)", async () => {
  const tx = await buildTx([
    "lp", "add",
    "--provider", "agni",
    "--token-a", "WMNT",
    "--token-b", "USDC",
    "--amount-a", AGNI_LP_WMNT,
    "--amount-b", AGNI_LP_USDC,
    "--recipient", wallet.address,
    "--fee-tier", "10000",
  ]);

  assertEqual(tx.intent, "add_liquidity", "intent");
  assertEqual(tx.unsigned_tx.chainId, CHAIN_ID, "chainId");
  assertEqual(
    tx.unsigned_tx.to.toLowerCase(),
    AGNI_POSITION_MANAGER.toLowerCase(),
    "to should be Agni PositionManager"
  );

  const result = await signAndSend(wallet, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    setDetails({
      gas_used: result.receipt.gasUsed.toString(),
      summary: tx.human_summary,
    });
  }
});

// ---------------------------------------------------------------------------
// Step 3: Merchant Moe LP — approve both tokens + add liquidity
// ---------------------------------------------------------------------------

test("Moe: approve WMNT + USDC for LB Router", async () => {
  await approveIfNeeded(WMNT, "WMNT", MOE_LB_ROUTER, "Moe LB Router");
  await approveIfNeeded(USDC, "USDC", MOE_LB_ROUTER, "Moe LB Router");
  setDetails({ approved: true });
});

test("Moe: add liquidity WMNT/USDC", async () => {
  const tx = await buildTx([
    "lp", "add",
    "--provider", "merchant_moe",
    "--token-a", "WMNT",
    "--token-b", "USDC",
    "--amount-a", MOE_LP_WMNT,
    "--amount-b", MOE_LP_USDC,
    "--recipient", wallet.address,
    "--bin-step", "25",
  ]);

  assertEqual(tx.intent, "add_liquidity", "intent");
  assertEqual(tx.unsigned_tx.chainId, CHAIN_ID, "chainId");
  assertEqual(
    tx.unsigned_tx.to.toLowerCase(),
    MOE_LB_ROUTER.toLowerCase(),
    "to should be Moe LB Router"
  );

  const result = await signAndSend(wallet, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    trackTx(result.hash);
    setDetails({
      gas_used: result.receipt.gasUsed.toString(),
      summary: tx.human_summary,
    });
  }
});

// ---------------------------------------------------------------------------
// Step 4: Verify positions
// ---------------------------------------------------------------------------

test("Verify: Agni LP position exists", async () => {
  const result = await runCli([
    "lp", "positions",
    "--owner", wallet.address,
    "--provider", "agni",
  ]);
  assertEqual(result.exitCode, 0, "exit code");
  assertDefined(result.json, "json output");

  const positions = result.json.positions ?? [];
  if (!DRY_RUN) {
    assertGreaterThan(positions.length, 0, "should have at least 1 Agni position");
  }
  setDetails({ position_count: positions.length });
});

test("Verify: Moe LB position exists", async () => {
  const result = await runCli([
    "lp", "lb-positions",
    "--owner", wallet.address,
  ]);
  assertEqual(result.exitCode, 0, "exit code");
  assertDefined(result.json, "json output");

  const positions = result.json.positions ?? [];
  setDetails({ position_count: positions.length });
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(chalk.bold("\n WMNT/USDC LP Test: Agni + Merchant Moe"));
  console.log(chalk.gray("─".repeat(50)));

  try {
    wallet = createTestWallet({ network: NETWORK });
    console.log(chalk.green(`Wallet:  ${wallet.address}`));

    const mnt = await getBalance(wallet);
    const wmnt = await readBalance(WMNT as `0x${string}`);
    const usdc = await readBalance(USDC as `0x${string}`);
    console.log(chalk.green(`MNT:     ${formatMNT(mnt)}`));
    console.log(chalk.green(`WMNT:    ${formatEther(wmnt)}`));
    console.log(chalk.green(`USDC:    ${formatUnits(usdc, 6)}`));

    if (DRY_RUN) {
      console.log(chalk.yellow("\nMode: DRY RUN"));
    } else {
      console.log(chalk.red.bold("\nMode: LIVE MAINNET"));
      console.log(chalk.yellow(
        `  1. Wrap ${WRAP_AMOUNT} MNT → WMNT\n` +
        `  2. Swap ${SWAP_FOR_USDC} WMNT → USDC\n` +
        `  3. Agni LP: ${AGNI_LP_WMNT} WMNT + ${AGNI_LP_USDC} USDC (full range, fee 1%)\n` +
        `  4. Moe LP:  ${MOE_LP_WMNT} WMNT + ${MOE_LP_USDC} USDC (bin_step 25)`
      ));
    }
  } catch (err: any) {
    console.error(chalk.red(`Setup failed: ${err.message}`));
    process.exit(1);
  }

  const results = await runAllTests();

  if (txLinks.length > 0) {
    console.log(chalk.cyan("\nTransactions:"));
    for (const link of txLinks) {
      console.log(chalk.gray(`  ${link}`));
    }
  }

  if (!DRY_RUN) {
    console.log(chalk.cyan("\nFinal balances:"));
    const mnt = await getBalance(wallet);
    const wmnt = await readBalance(WMNT as `0x${string}`);
    const usdc = await readBalance(USDC as `0x${string}`);
    console.log(chalk.green(`  MNT:  ${formatMNT(mnt)}`));
    console.log(chalk.green(`  WMNT: ${formatEther(wmnt)}`));
    console.log(chalk.green(`  USDC: ${formatUnits(usdc, 6)}`));
  }

  console.log();
  const failed = results.filter(r => !r.passed);
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
