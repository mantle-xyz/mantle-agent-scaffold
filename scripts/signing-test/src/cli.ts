/**
 * CLI executor — calls mantle-cli as a child process and parses JSON output.
 * This way we test the actual CLI binary end-to-end.
 */

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Path to the built CLI binary
const CLI_PATH = resolve(__dirname, "../../../packages/cli/dist/index.js");

// ---------------------------------------------------------------------------
// Commands that implement the mandatory two-step dry-run / confirm flow.
//
// These are the CLI sub-paths (args[0] + " " + args[1]) whose handlers
// enforce: no-flags → CONFIRMATION_REQUIRED; --dry-run → preview + token;
// --confirm --token → unsigned_tx.
//
// Commands NOT in this set (e.g. "approve") return unsigned_tx directly and
// are called without the extra round-trip.
// ---------------------------------------------------------------------------
const TWO_STEP_COMMANDS = new Set([
  "swap build-swap",
  "swap wrap-mnt",
  "swap unwrap-mnt",
  "aave supply",
  "aave borrow",
  "aave repay",
  "aave withdraw",
  "aave set-collateral",
  "lp add",
  "lp remove",
  "lp collect-fees",
]);

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json: any;
}

/**
 * Execute a mantle-cli command and return parsed results.
 *
 * @param args - CLI arguments (e.g. ["swap", "build-swap", "--provider", "agni", ...])
 * @param opts - Extra options
 */
export function runCli(
  args: string[],
  opts?: { network?: string; timeout?: number }
): Promise<CliResult> {
  const network = opts?.network ?? "mainnet";
  const timeout = opts?.timeout ?? 30_000;

  const fullArgs = [
    CLI_PATH,
    "--network", network,
    "--json",
    ...args,
  ];

  return new Promise((res) => {
    execFile("node", fullArgs, { timeout }, (err, stdout, stderr) => {
      const exitCode = err?.code ? (typeof err.code === "number" ? err.code : 1) : 0;

      let json: any = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        // Not JSON — that's fine for some commands
      }

      res({ exitCode, stdout, stderr, json });
    });
  });
}

/**
 * Convenience: call a mantle-cli command that returns an unsigned_tx.
 *
 * For commands in TWO_STEP_COMMANDS (swap build-swap, aave supply, lp add, etc.)
 * this automatically performs the mandatory dry-run → confirm two-step flow:
 *   Step 1: run with --dry-run  → receive confirmation_token
 *   Step 2: run with --confirm --token <tok> → receive unsigned_tx
 *
 * For other commands (e.g. "approve") the result is returned directly.
 *
 * Throws if either step fails or the expected fields are absent.
 */
export async function buildTx(
  args: string[],
  opts?: { network?: string }
): Promise<{
  intent: string;
  human_summary: string;
  unsigned_tx: {
    to: string;
    data: string;
    value: string;
    chainId: number;
    gas?: string;
  };
  warnings: string[];
  [key: string]: unknown;
}> {
  const commandKey = args.slice(0, 2).join(" ");

  if (TWO_STEP_COMMANDS.has(commandKey)) {
    return buildTxTwoStep(args, opts);
  }

  return buildTxDirect(args, opts);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Execute the mandatory dry-run → confirm two-step flow.
 *
 * Step 1 appends --dry-run and extracts the confirmation_token from the
 * preview payload. Step 2 appends --confirm --token <tok> and returns the
 * full result containing unsigned_tx.
 */
async function buildTxTwoStep(
  args: string[],
  opts?: { network?: string }
): Promise<any> {
  // ── Step 1: dry-run ──────────────────────────────────────────────────────
  const dryResult = await runCli([...args, "--dry-run"], opts);

  if (dryResult.exitCode !== 0) {
    throw new Error(
      `CLI dry-run failed (exit ${dryResult.exitCode}):\n` +
      `  args: ${args.join(" ")} --dry-run\n` +
      `  stderr: ${dryResult.stderr}\n` +
      `  stdout: ${dryResult.stdout}`
    );
  }

  const token = dryResult.json?.confirmation_token as string | undefined;
  if (!token) {
    throw new Error(
      `CLI dry-run did not return confirmation_token:\n` +
      `  args: ${args.join(" ")} --dry-run\n` +
      `  stdout: ${dryResult.stdout}`
    );
  }

  // ── Step 2: confirm ──────────────────────────────────────────────────────
  const confirmResult = await runCli(
    [...args, "--confirm", "--token", token],
    opts
  );

  if (confirmResult.exitCode !== 0) {
    throw new Error(
      `CLI confirm failed (exit ${confirmResult.exitCode}):\n` +
      `  args: ${args.join(" ")} --confirm --token <tok>\n` +
      `  stderr: ${confirmResult.stderr}\n` +
      `  stdout: ${confirmResult.stdout}`
    );
  }

  if (!confirmResult.json?.unsigned_tx) {
    throw new Error(
      `CLI confirm did not return unsigned_tx:\n` +
      `  args: ${args.join(" ")} --confirm --token <tok>\n` +
      `  stdout: ${confirmResult.stdout}`
    );
  }

  return confirmResult.json;
}

/**
 * Execute a command that returns its result directly (no dry-run flow).
 * Used for commands like `approve` that are exempt from the two-step gate.
 *
 * Unlike buildTxTwoStep, this does NOT require unsigned_tx in the response —
 * some commands legitimately return without one (e.g. approve_skip when the
 * allowance is already sufficient). Callers should inspect `result.intent`
 * and handle the skip case before reading `result.unsigned_tx`.
 */
async function buildTxDirect(
  args: string[],
  opts?: { network?: string }
): Promise<any> {
  const result = await runCli(args, opts);

  if (result.exitCode !== 0) {
    throw new Error(
      `CLI command failed (exit ${result.exitCode}):\n` +
      `  args: ${args.join(" ")}\n` +
      `  stderr: ${result.stderr}\n` +
      `  stdout: ${result.stdout}`
    );
  }

  if (!result.json) {
    throw new Error(
      `CLI command returned no JSON output:\n` +
      `  args: ${args.join(" ")}\n` +
      `  stdout: ${result.stdout}`
    );
  }

  return result.json;
}
