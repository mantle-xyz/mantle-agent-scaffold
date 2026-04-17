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
