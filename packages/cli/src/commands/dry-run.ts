/**
 * Shared dry-run / confirmation enforcement for CLI build commands.
 *
 * Usage pattern:
 *   1. User runs:  mantle-cli swap build-swap … --dry-run --json
 *      → Returns:  { preview: {…}, confirmation_token: "mntl_…", expires_at: "…" }
 *
 *   2. User runs:  mantle-cli swap build-swap … --confirm --token mntl_… --json
 *      → Returns:  full result with unsigned_tx (identical to the old default behaviour)
 *
 *   Running without either flag → exits with a clear "run --dry-run first" message.
 *
 * The commandHash is derived from the core operation parameters so that a token
 * generated for one set of parameters cannot be used to confirm a different set.
 */

import {
  generateConfirmationToken,
  validateConfirmationToken,
  buildCommandHash
} from "../confirmation-token.js";
import { formatJson } from "../formatter.js";

export interface DryRunOpts {
  dryRun?: boolean;
  confirm?: boolean;
  token?: string;
}

/**
 * Enforce the dry-run → confirm two-step flow.
 *
 * @param opts        The parsed commander options (must include dryRun/confirm/token)
 * @param hashParams  Key-value pairs that uniquely describe this operation.
 *                    Used to bind a token to a specific set of parameters.
 * @param handler     Async function that calls the underlying tool and returns its result.
 * @param isJson      Whether to output JSON (from global --json flag).
 * @param formatHuman Optional function to render the full result in human-readable form.
 *                    If omitted, JSON is always used.
 */
export async function runWithDryRunGuard<T extends Record<string, unknown>>(opts: {
  dryRun: boolean;
  confirm: boolean;
  token: string | undefined;
  hashParams: Record<string, unknown>;
  handler: () => Promise<T>;
  isJson: boolean;
  formatHuman?: (result: T) => void;
}): Promise<void> {
  const { dryRun, confirm, token, hashParams, handler, isJson, formatHuman } = opts;

  // ── Mutual exclusion ──────────────────────────────────────────────────────
  if (dryRun && confirm) {
    console.error(
      "Error: --dry-run and --confirm are mutually exclusive. Use --dry-run first to preview, then --confirm --token <token> to execute."
    );
    process.exit(1);
  }

  // ── No mode selected → reject ─────────────────────────────────────────────
  if (!dryRun && !confirm) {
    const errorPayload = {
      error: true,
      code: "CONFIRMATION_REQUIRED",
      message: "Build commands require explicit confirmation of intent.",
      suggestion:
        "Run the same command with --dry-run first to preview the operation and obtain a confirmation token, " +
        "then re-run with --confirm --token <token> to generate the unsigned transaction.",
      requires_user_input: false,
      retryable: false,
      _stop_instruction:
        "\u26A0\uFE0F This command requires a two-step confirmation flow. " +
        "Step 1: add --dry-run to preview. Step 2: add --confirm --token <token> to execute."
    };
    if (isJson) {
      formatJson(errorPayload);
    } else {
      console.error(errorPayload._stop_instruction);
      console.error(`  Run with --dry-run first, then --confirm --token <token>.`);
    }
    process.exit(1);
  }

  const commandHash = buildCommandHash(hashParams);

  // ── --confirm path ─────────────────────────────────────────────────────────
  if (confirm) {
    if (!token) {
      const errPayload = {
        error: true,
        code: "TOKEN_MISSING",
        message: "--confirm requires --token <confirmation_token>.",
        suggestion: "Run the same command with --dry-run to get a token, then pass it with --token.",
        requires_user_input: false,
        retryable: false
      };
      if (isJson) {
        formatJson(errPayload);
      } else {
        console.error("Error: --confirm requires --token <confirmation_token>.");
        console.error("  Run with --dry-run first to get a token.");
      }
      process.exit(1);
    }

    try {
      validateConfirmationToken(token, commandHash);
    } catch (err) {
      const errPayload = {
        error: true,
        code: "INVALID_CONFIRMATION_TOKEN",
        message: (err as Error).message,
        suggestion:
          "Run the same command with --dry-run to get a fresh confirmation token, then pass it with --token.",
        requires_user_input: false,
        retryable: false,
        _stop_instruction:
          "\u26A0\uFE0F ERROR \u2014 Confirmation token is invalid or expired. " +
          "Run the same command with --dry-run to obtain a fresh token."
      };
      if (isJson) {
        formatJson(errPayload);
      } else {
        console.error(`Error: ${(err as Error).message}`);
      }
      process.exit(1);
    }

    // Token valid — execute
    const result = await handler();
    if (isJson) {
      formatJson(result);
    } else if (formatHuman) {
      formatHuman(result);
    } else {
      formatJson(result);
    }
    return;
  }

  // ── --dry-run path ─────────────────────────────────────────────────────────
  const result = await handler();

  // Generate a confirmation token bound to these parameters
  const { confirmation_token: confirmationToken, expires_at } = generateConfirmationToken(commandHash);

  // Build the preview — include all metadata but omit the calldata (unsigned_tx.data)
  // so the agent/user cannot accidentally broadcast a half-confirmed tx.
  const unsignedTx = result.unsigned_tx as Record<string, unknown> | undefined;
  const preview: Record<string, unknown> = {
    intent: result.intent,
    human_summary: result.human_summary,
    warnings: result.warnings ?? [],
    estimated_to: unsignedTx?.to,
    estimated_value: unsignedTx?.value,
    estimated_chain_id: unsignedTx?.chainId,
    estimated_gas: unsignedTx?.gas ?? "auto"
  };

  // Carry forward any protocol-specific fields (pool_params, asset, etc.)
  for (const [k, v] of Object.entries(result)) {
    if (
      k !== "unsigned_tx" &&
      k !== "intent" &&
      k !== "human_summary" &&
      k !== "warnings" &&
      k !== "built_at_utc"
    ) {
      preview[k] = v;
    }
  }

  const dryRunResult = {
    dry_run: true,
    preview,
    confirmation_token: confirmationToken,
    expires_at,
    to_proceed:
      "Re-run the same command with --confirm --token " + confirmationToken + " to generate the unsigned transaction."
  };

  if (isJson) {
    formatJson(dryRunResult);
  } else {
    console.log("\n  DRY RUN — No transaction generated.\n");
    console.log(`  Summary:  ${result.human_summary}`);
    if (Array.isArray(result.warnings) && result.warnings.length > 0) {
      console.log("  Warnings:");
      for (const w of result.warnings as string[]) {
        console.log(`    - ${w}`);
      }
    }
    console.log(`\n  Confirmation Token: ${confirmationToken}`);
    console.log(`  Expires At:         ${expires_at}`);
    console.log(`\n  To proceed:\n  Re-run with --confirm --token ${confirmationToken}\n`);
  }
}
