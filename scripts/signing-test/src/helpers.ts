/**
 * Shared helpers for signing-test scenarios.
 *
 * Provides:
 *   - createTestWallet setup with balance printout
 *   - approveIfNeeded: CLI approve helper that skips when allowance sufficient
 *   - trackTx: register a tx hash for the summary
 *   - readBalance: read ERC-20 balance via viem
 *   - readActiveId: query LB pair's active bin (uint24)
 *   - runScenario: standard main() wrapper
 */

import { erc20Abi, formatEther, formatUnits, parseAbi } from "viem";
import chalk from "chalk";

import {
  createTestWallet,
  signAndSend,
  getBalance,
  formatMNT,
  type TestWallet,
} from "./wallet.js";
import { buildTx, runCli } from "./cli.js";
import { runAllTests, setTxHash } from "./runner.js";
import { assertEqual } from "./assert.js";
import {
  EXPLORER_TX,
  NETWORK,
  TOKEN_DECIMALS,
  TOKEN_SYMBOL,
  WMNT,
  USDC,
  USDT,
  USDT0,
  USDe,
} from "./constants.js";

export const DRY_RUN = process.env.DRY_RUN === "true";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

export const txLinks: string[] = [];

export function trackTx(hash: string) {
  setTxHash(hash);
  txLinks.push(`${EXPLORER_TX}${hash}`);
}

// ---------------------------------------------------------------------------
// Balance helpers
// ---------------------------------------------------------------------------

export async function readBalance(
  wallet: TestWallet,
  token: `0x${string}`,
): Promise<bigint> {
  return wallet.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [wallet.address as `0x${string}`],
  }) as Promise<bigint>;
}

export function formatTokenAmount(amountRaw: bigint, token: string): string {
  const decimals = TOKEN_DECIMALS[token] ?? 18;
  return formatUnits(amountRaw, decimals);
}

// ---------------------------------------------------------------------------
// LB pair on-chain helpers
// ---------------------------------------------------------------------------

const LB_PAIR_ABI = parseAbi([
  "function getActiveId() view returns (uint24)",
]);

export async function readActiveId(
  wallet: TestWallet,
  pairAddress: string,
): Promise<number> {
  const id = await wallet.publicClient.readContract({
    address: pairAddress as `0x${string}`,
    abi: LB_PAIR_ABI,
    functionName: "getActiveId",
  });
  return Number(id);
}

// ---------------------------------------------------------------------------
// CLI approve helper
// ---------------------------------------------------------------------------

export async function approveIfNeeded(
  wallet: TestWallet,
  token: string,
  spender: string,
  spenderName: string,
): Promise<void> {
  const symbol = TOKEN_SYMBOL[token] ?? token.slice(0, 8);
  const tx = await buildTx([
    "approve",
    "--token", token,
    "--spender", spender,
    "--amount", "max",
    "--owner", wallet.address,
  ]);

  if (tx.intent === "approve_skip") {
    console.log(`  (${symbol} → ${spenderName}: allowance already sufficient)`);
    return;
  }

  const result = await signAndSend(wallet, tx.unsigned_tx, { dryRun: DRY_RUN });
  if (result) {
    assertEqual(result.receipt.status, "success", `${symbol} approve tx status`);
    trackTx(result.hash);
  }
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

export async function printBalances(wallet: TestWallet, title: string): Promise<void> {
  console.log(chalk.cyan(`\n${title}`));
  const [mnt, wmnt, usdc, usdt, usdt0, usde] = await Promise.all([
    getBalance(wallet),
    readBalance(wallet, WMNT),
    readBalance(wallet, USDC),
    readBalance(wallet, USDT),
    readBalance(wallet, USDT0),
    readBalance(wallet, USDe),
  ]);
  console.log(chalk.green(`  MNT:   ${formatMNT(mnt)}`));
  console.log(chalk.green(`  WMNT:  ${formatEther(wmnt)}`));
  console.log(chalk.green(`  USDC:  ${formatUnits(usdc, 6)}`));
  console.log(chalk.green(`  USDT:  ${formatUnits(usdt, 6)}`));
  console.log(chalk.green(`  USDT0: ${formatUnits(usdt0, 6)}`));
  console.log(chalk.green(`  USDe:  ${formatEther(usde)}`));
}

// ---------------------------------------------------------------------------
// Scenario runner wrapper
// ---------------------------------------------------------------------------

export interface ScenarioOptions {
  name: string;
  description: string;
  /** Lines shown to the user when in LIVE mode, describing what will happen. */
  livePreview: string[];
}

export async function runScenario(opts: ScenarioOptions): Promise<void> {
  console.log(chalk.bold(`\n ${opts.name}`));
  console.log(chalk.gray(opts.description));
  console.log(chalk.gray("─".repeat(60)));

  let wallet: TestWallet;
  try {
    wallet = createTestWallet({ network: NETWORK });
    console.log(chalk.green(`Wallet:  ${wallet.address}`));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__wallet = wallet;
    await printBalances(wallet, "Initial balances:");

    if (DRY_RUN) {
      console.log(chalk.yellow("\nMode: DRY RUN"));
    } else {
      console.log(chalk.red.bold("\nMode: LIVE MAINNET"));
      for (const line of opts.livePreview) {
        console.log(chalk.yellow(`  ${line}`));
      }
    }
  } catch (err) {
    console.error(chalk.red(`Setup failed: ${(err as Error).message}`));
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
    await printBalances(wallet, "Final balances:");
  }

  console.log();
  const failed = results.filter((r) => !r.passed);
  process.exit(failed.length > 0 ? 1 : 0);
}

/** Grab the wallet set up by runScenario (convenience for test bodies). */
export function wallet(): TestWallet {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = (globalThis as any).__wallet as TestWallet | undefined;
  if (!w) throw new Error("wallet not initialized — call runScenario first");
  return w;
}

/** Re-export runCli so scenario files can verify CLI state. */
export { runCli };
