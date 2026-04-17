/**
 * Scenario: Dry-run / Confirm flow + Error-payload shape (Layer 1 & Layer 5)
 *
 * This scenario verifies the two behavioural improvements introduced by the
 * dry-run feature branch:
 *
 *   Layer 1 — Error payloads as "information missing" signals
 *     • CONFIRMATION_REQUIRED: any build command called without --dry-run or
 *       --confirm exits 1 with a structured error payload.
 *     • TOKEN_NOT_FOUND: unknown token returns requires_user_input, a
 *       question_for_user string, do_not guidance, and a _stop_instruction.
 *     • AMBIGUOUS_TOKEN: ambiguous symbols (e.g. "USDT") return
 *       requires_user_input + available_options so the agent can ask the user
 *       which token they mean.
 *
 *   Layer 5 — Mandatory two-step confirmation gate in the CLI
 *     • --dry-run returns a preview payload with confirmation_token & expires_at.
 *     • --confirm --token <tok> returns the full unsigned_tx.
 *     • A tampered or wrong token is rejected (INVALID_CONFIRMATION_TOKEN).
 *     • A token from different args is rejected (argument mismatch).
 *
 * These tests do NOT require TEST_PRIVATE_KEY — they only call the CLI and
 * inspect JSON output. Network access is needed for the dry-run/confirm tests
 * (pool lookup) but not for the error-payload tests (registry is in-memory).
 *
 * Usage:
 *   npm run test:dry-run
 */

import chalk from "chalk";
import { runCli } from "./cli.js";
import { test, runAllTests, setDetails } from "./runner.js";
import { assertEqual, assertDefined, assert, assertIncludes } from "./assert.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Dummy recipient — not used for signing, just to pass address validation.
const DUMMY_ADDR = "0x0000000000000000000000000000000000000001";

// Base args for a valid WMNT → USDe swap on Agni — reused across flow tests.
const SWAP_ARGS = [
  "swap", "build-swap",
  "--provider", "agni",
  "--in", "WMNT",
  "--out", "USDe",
  "--amount", "0.01",
  "--recipient", DUMMY_ADDR,
];

// ---------------------------------------------------------------------------
// Layer 1 — Error payload shape
// ---------------------------------------------------------------------------

// ── 1a. CONFIRMATION_REQUIRED ───────────────────────────────────────────────

test("CONFIRMATION_REQUIRED: build-swap with no flags exits 1", async () => {
  const result = await runCli(SWAP_ARGS);

  assertEqual(result.exitCode, 1, "exit code must be 1");

  const payload = result.json;
  assertDefined(payload, "JSON payload");
  assertEqual(payload.error, true, "error flag");
  assertEqual(payload.code, "CONFIRMATION_REQUIRED", "error code");

  // Must contain guidance for the agent.
  assertDefined(payload.suggestion, "suggestion field");
  assert(
    typeof payload.suggestion === "string" && payload.suggestion.length > 0,
    "suggestion is non-empty string"
  );

  // _stop_instruction must be present so the LLM reads it before anything else.
  assertDefined(payload._stop_instruction, "_stop_instruction field");

  setDetails({
    code: payload.code,
    message: payload.message,
    suggestion: payload.suggestion?.slice(0, 80),
    has_stop_instruction: Boolean(payload._stop_instruction),
  });
});

test("CONFIRMATION_REQUIRED: aave supply with no flags exits 1", async () => {
  const result = await runCli([
    "aave", "supply",
    "--asset", "WMNT",
    "--amount", "0.1",
    "--on-behalf-of", DUMMY_ADDR,
  ]);

  assertEqual(result.exitCode, 1, "exit code must be 1");
  const payload = result.json;
  assertDefined(payload, "JSON payload");
  assertEqual(payload.error, true, "error flag");
  assertEqual(payload.code, "CONFIRMATION_REQUIRED", "error code");
  assertDefined(payload._stop_instruction, "_stop_instruction field");
  setDetails({ code: payload.code });
});

test("CONFIRMATION_REQUIRED: lp add with no flags exits 1", async () => {
  const result = await runCli([
    "lp", "add",
    "--provider", "agni",
    "--token-a", "WMNT",
    "--token-b", "USDe",
    "--amount-a", "0.1",
    "--amount-b", "0.1",
    "--recipient", DUMMY_ADDR,
    "--fee-tier", "500",
  ]);

  assertEqual(result.exitCode, 1, "exit code must be 1");
  const payload = result.json;
  assertDefined(payload, "JSON payload");
  assertEqual(payload.error, true, "error flag");
  assertEqual(payload.code, "CONFIRMATION_REQUIRED", "error code");
  assertDefined(payload._stop_instruction, "_stop_instruction field");
  setDetails({ code: payload.code });
});

// ── 1b. TOKEN_NOT_FOUND ─────────────────────────────────────────────────────

test("TOKEN_NOT_FOUND: unknown token returns structured error payload", async () => {
  const result = await runCli([
    "swap", "build-swap",
    "--provider", "agni",
    "--in", "FAKECOIN_DOES_NOT_EXIST",
    "--out", "USDe",
    "--amount", "0.01",
    "--recipient", DUMMY_ADDR,
    "--dry-run",    // Use --dry-run so we get past CONFIRMATION_REQUIRED
  ]);

  // Should exit non-zero due to token error
  assert(result.exitCode !== 0, "exit code should be non-zero on token error");

  const payload = result.json;
  assertDefined(payload, "JSON payload");
  assertEqual(payload.error, true, "error flag");
  assertEqual(payload.code, "TOKEN_NOT_FOUND", "error code");

  // Layer 1 fields — all must be present for the LLM to know how to handle this.
  assertEqual(payload.requires_user_input, true, "requires_user_input must be true");
  assertDefined(payload.question_for_user, "question_for_user field");
  assert(
    typeof payload.question_for_user === "string" && payload.question_for_user.length > 10,
    "question_for_user is a meaningful string"
  );
  assertDefined(payload.do_not, "do_not field");
  assert(Array.isArray(payload.do_not) && payload.do_not.length > 0, "do_not is a non-empty array");
  assertDefined(payload._stop_instruction, "_stop_instruction field");
  assertIncludes(payload._stop_instruction as string, "STOP", "_stop_instruction mentions STOP");

  setDetails({
    code: payload.code,
    requires_user_input: payload.requires_user_input,
    question_for_user: (payload.question_for_user as string)?.slice(0, 80),
    do_not_count: (payload.do_not as string[])?.length,
    has_stop_instruction: Boolean(payload._stop_instruction),
  });
});

// ── 1c. AMBIGUOUS_TOKEN ─────────────────────────────────────────────────────

test("AMBIGUOUS_TOKEN: 'USDT' input returns disambiguation error with options", async () => {
  const result = await runCli([
    "swap", "build-swap",
    "--provider", "agni",
    "--in", "USDT",       // Ambiguous: could be USDT or USDT0
    "--out", "WMNT",
    "--amount", "0.01",
    "--recipient", DUMMY_ADDR,
    "--dry-run",
  ]);

  assert(result.exitCode !== 0, "exit code should be non-zero on ambiguous token");

  const payload = result.json;
  assertDefined(payload, "JSON payload");
  assertEqual(payload.error, true, "error flag");
  assertEqual(payload.code, "AMBIGUOUS_TOKEN", "error code");

  // Must ask the user to choose.
  assertEqual(payload.requires_user_input, true, "requires_user_input must be true");
  assertDefined(payload.question_for_user, "question_for_user field");

  // available_options should be promoted from details to top-level for easy access.
  assertDefined(payload.available_options, "available_options field");
  assert(
    Array.isArray(payload.available_options) && payload.available_options.length >= 2,
    "available_options has at least 2 candidates"
  );

  // do_not prevents the LLM from guessing.
  assertDefined(payload.do_not, "do_not field");
  assert(Array.isArray(payload.do_not) && payload.do_not.length > 0, "do_not is non-empty");

  assertDefined(payload._stop_instruction, "_stop_instruction field");

  setDetails({
    code: payload.code,
    candidates: payload.available_options,
    question_for_user: (payload.question_for_user as string)?.slice(0, 80),
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — Two-step dry-run / confirm flow
// ---------------------------------------------------------------------------

// We need to share the confirmation_token from the --dry-run step into the
// subsequent --confirm step. Use module-level state since tests run serially.
let capturedToken: string | null = null;

// ── 5a. --dry-run returns preview + confirmation_token ───────────────────────

test("--dry-run returns preview payload with confirmation_token", async () => {
  const result = await runCli([...SWAP_ARGS, "--dry-run"]);

  assertEqual(result.exitCode, 0, "exit code must be 0");

  const payload = result.json;
  assertDefined(payload, "JSON payload");
  assertEqual(payload.dry_run, true, "dry_run flag");

  // confirmation_token must be present and in the expected format.
  assertDefined(payload.confirmation_token, "confirmation_token field");
  assert(
    typeof payload.confirmation_token === "string" &&
    (payload.confirmation_token as string).startsWith("mntl_"),
    "confirmation_token starts with 'mntl_'"
  );

  // expires_at must be present and in the future.
  assertDefined(payload.expires_at, "expires_at field");
  const expiresAt = new Date(payload.expires_at as string).getTime();
  assert(!isNaN(expiresAt) && expiresAt > Date.now(), "expires_at is a future ISO timestamp");

  // preview should contain human-readable operation details.
  assertDefined(payload.preview, "preview field");

  // to_proceed should tell the agent what command to run next.
  assertDefined(payload.to_proceed, "to_proceed field");
  assertIncludes(payload.to_proceed as string, "--confirm", "to_proceed mentions --confirm");

  // Must NOT include unsigned_tx — that's only released after confirmation.
  assert(!payload.unsigned_tx, "unsigned_tx must NOT be present in dry-run response");

  // Capture the token for the subsequent confirm test.
  capturedToken = payload.confirmation_token as string;

  setDetails({
    dry_run: payload.dry_run,
    token_prefix: (payload.confirmation_token as string).slice(0, 10) + "...",
    expires_at: payload.expires_at,
    has_preview: Boolean(payload.preview),
    has_to_proceed: Boolean(payload.to_proceed),
  });
});

// ── 5b. --confirm --token <valid> returns unsigned_tx ───────────────────────

test("--confirm with valid token returns unsigned_tx", async () => {
  assert(capturedToken !== null, "previous dry-run test must have captured a token");

  const result = await runCli([
    ...SWAP_ARGS,
    "--confirm", "--token", capturedToken!,
  ]);

  assertEqual(result.exitCode, 0, "exit code must be 0");

  const payload = result.json;
  assertDefined(payload, "JSON payload");

  // Must contain a properly shaped unsigned transaction.
  assertDefined(payload.unsigned_tx, "unsigned_tx field");
  const tx = payload.unsigned_tx as Record<string, unknown>;
  assertDefined(tx.to, "unsigned_tx.to");
  assertDefined(tx.data, "unsigned_tx.data");
  assertDefined(tx.value, "unsigned_tx.value");
  assertDefined(tx.chainId, "unsigned_tx.chainId");
  assertEqual(tx.chainId as number, 5000, "chainId is Mantle mainnet (5000)");

  // Must contain intent and human summary.
  assertDefined(payload.intent, "intent field");
  assertDefined(payload.human_summary, "human_summary field");

  // Token is consumed — it should NOT work a second time (tested in 5d).
  setDetails({
    intent: payload.intent,
    tx_to: tx.to,
    tx_chainId: tx.chainId,
    calldata_length: typeof tx.data === "string" ? (tx.data as string).length : "?",
  });
});

// ── 5c. --confirm with tampered token is rejected ───────────────────────────

test("--confirm with tampered token is rejected", async () => {
  // Flip the last character of a fresh dry-run token to produce an invalid HMAC.
  const dryResult = await runCli([...SWAP_ARGS, "--dry-run"]);
  assertEqual(dryResult.exitCode, 0, "dry-run for tamper test");
  const freshToken = dryResult.json?.confirmation_token as string;
  assertDefined(freshToken, "fresh token for tamper test");

  // Tamper: replace last char
  const tampered = freshToken.slice(0, -1) + (freshToken.endsWith("a") ? "b" : "a");

  const result = await runCli([
    ...SWAP_ARGS,
    "--confirm", "--token", tampered,
  ]);

  assert(result.exitCode !== 0, "tampered token must be rejected (non-zero exit)");

  const payload = result.json;
  assertDefined(payload, "JSON payload");
  assertEqual(payload.error, true, "error flag");
  assertEqual(payload.code, "INVALID_CONFIRMATION_TOKEN", "error code");
  assertDefined(payload._stop_instruction, "_stop_instruction");

  setDetails({ rejected_code: payload.code });
});

// ── 5d. --confirm with a token generated from different args is rejected ─────

test("--confirm with mismatched args is rejected (command-hash mismatch)", async () => {
  // Generate a token for a DIFFERENT amount (0.99 instead of 0.01).
  const differentArgs = [
    "swap", "build-swap",
    "--provider", "agni",
    "--in", "WMNT",
    "--out", "USDe",
    "--amount", "0.99",    // Different from SWAP_ARGS which uses 0.01
    "--recipient", DUMMY_ADDR,
  ];

  const dryResult = await runCli([...differentArgs, "--dry-run"]);
  assertEqual(dryResult.exitCode, 0, "dry-run for mismatch test");
  const mismatchToken = dryResult.json?.confirmation_token as string;
  assertDefined(mismatchToken, "mismatch token");

  // Use the token from 0.99 WMNT but the SWAP_ARGS for 0.01 WMNT — should fail.
  const result = await runCli([
    ...SWAP_ARGS,
    "--confirm", "--token", mismatchToken,
  ]);

  assert(result.exitCode !== 0, "mismatched token must be rejected (non-zero exit)");

  const payload = result.json;
  assertDefined(payload, "JSON payload");
  assertEqual(payload.error, true, "error flag");
  assertEqual(payload.code, "INVALID_CONFIRMATION_TOKEN", "error code");

  setDetails({ rejected_code: payload.code });
});

// ── 5e. Mutual exclusion: --dry-run and --confirm together is rejected ────────

test("--dry-run and --confirm together is rejected", async () => {
  const result = await runCli([
    ...SWAP_ARGS,
    "--dry-run", "--confirm", "--token", "mntl_fake",
  ]);

  // Commander should reject this combination.
  assert(result.exitCode !== 0, "mutual exclusion must be rejected");

  setDetails({ exit_code: result.exitCode });
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(chalk.bold("\n Dry-run / Confirm Flow + Error Payload Tests"));
  console.log(chalk.gray("Tests Layer 1 (error payloads) and Layer 5 (two-step gate)"));
  console.log(chalk.gray("─".repeat(60)));
  console.log(chalk.gray("Note: no TEST_PRIVATE_KEY required — CLI output only\n"));

  const results = await runAllTests();

  const failed = results.filter((r) => !r.passed);
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
