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

  return new Promise((res, rej) => {
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
 * Throws if the command fails or doesn't return the expected shape.
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
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
  };
  warnings: string[];
  [key: string]: unknown;
}> {
  const result = await runCli(args, opts);

  if (result.exitCode !== 0) {
    throw new Error(
      `CLI command failed (exit ${result.exitCode}):\n` +
      `  args: ${args.join(" ")}\n` +
      `  stderr: ${result.stderr}\n` +
      `  stdout: ${result.stdout}`
    );
  }

  if (!result.json?.unsigned_tx) {
    throw new Error(
      `CLI command did not return unsigned_tx:\n` +
      `  args: ${args.join(" ")}\n` +
      `  stdout: ${result.stdout}`
    );
  }

  return result.json;
}

/**
 * Two-step build — Step 1: dry-run.
 *
 * Calls the CLI with `--dry-run` appended. The CLI returns a preview
 * (intent, human_summary, warnings, pool parameters …) plus a single-use
 * `confirmation_token` that expires after 5 minutes. No `unsigned_tx` is
 * returned at this stage.
 *
 * Use {@link confirmBuild} with the token to obtain the actual unsigned_tx.
 */
export async function dryRunBuild(
  args: string[],
  opts?: { network?: string },
): Promise<{
  intent: string;
  confirmation_token?: string;
  human_summary?: string;
  warnings?: string[];
  [key: string]: unknown;
}> {
  const result = await runCli([...args, "--dry-run"], opts);

  if (result.exitCode !== 0) {
    throw new Error(
      `CLI dry-run failed (exit ${result.exitCode}):\n` +
        `  args: ${args.join(" ")}\n` +
        `  stderr: ${result.stderr}\n` +
        `  stdout: ${result.stdout}`,
    );
  }

  if (!result.json) {
    throw new Error(
      `CLI dry-run did not return JSON:\n` +
        `  args: ${args.join(" ")}\n` +
        `  stdout: ${result.stdout}`,
    );
  }

  return result.json;
}

/**
 * Two-step build — Step 2: confirm.
 *
 * Re-runs the same CLI command with `--confirm --confirmation-token <token>`.
 * The CLI validates that the parameters haven't changed since the dry-run,
 * consumes the single-use token, and returns the full result including
 * `unsigned_tx`.
 */
export async function confirmBuild(
  args: string[],
  confirmationToken: string,
  opts?: { network?: string },
): Promise<{
  intent: string;
  human_summary: string;
  unsigned_tx: {
    to: string;
    data: string;
    value: string;
    chainId: number;
    gas?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
  };
  warnings: string[];
  [key: string]: unknown;
}> {
  const result = await runCli(
    [...args, "--confirm", "--confirmation-token", confirmationToken],
    opts,
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `CLI confirm failed (exit ${result.exitCode}):\n` +
        `  args: ${args.join(" ")}\n` +
        `  stderr: ${result.stderr}\n` +
        `  stdout: ${result.stdout}`,
    );
  }

  if (!result.json?.unsigned_tx) {
    throw new Error(
      `CLI confirm did not return unsigned_tx:\n` +
        `  args: ${args.join(" ")}\n` +
        `  stdout: ${result.stdout}`,
    );
  }

  return result.json;
}
