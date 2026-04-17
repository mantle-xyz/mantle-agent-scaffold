/**
 * CLI Confirmation Token — two-step build flow
 *
 * Enforces an explicit `--dry-run` → `--confirm --token <tok>` cycle for all
 * mutating CLI build commands. Tokens are persisted in a JSON file under the
 * user's home directory so they survive across CLI invocations.
 *
 * Security model: tokens are HMAC-SHA-256 keyed on a per-user random secret.
 * This prevents forgery even if commandHash is known.
 * Tokens expire after TOKEN_TTL_MS milliseconds (default: 5 minutes).
 * Tokens are single-use: consumed on successful validation AND on hash-mismatch
 * (to prevent unlimited hash probing against a known token).
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Token lifetime: 5 minutes */
const TOKEN_TTL_MS = 5 * 60 * 1_000;

/** Token prefix — easy to spot in logs and agent output */
const TOKEN_PREFIX = "mntl_";

/**
 * Expected token format: mntl_ + 8-char nonce + 24-char HMAC slice = 37 chars total.
 * Tests can use the sentinel mntl_0000000000000000000000000000dead (37 chars) for
 * "structurally valid but non-existent" cases.
 */
const TOKEN_REGEX = /^mntl_[a-f0-9]{32}$/;

const STORE_DIR = join(homedir(), ".mantle");
const TOKEN_STORE_PATH = join(STORE_DIR, "confirmation-tokens.json");
const SECRET_PATH = join(STORE_DIR, "cli-secret");

/**
 * In test environments (VITEST=1) we skip filesystem persistence entirely
 * so tests don't write tokens to the user's ~/.mantle directory.
 */
const IS_TEST = Boolean(process.env.VITEST);

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface TokenRecord {
  commandHash: string;
  expiresAt: number; // Unix timestamp ms
}

// ---------------------------------------------------------------------------
// In-memory store (primary)
//
// Production: lazily loaded from disk on first access (each CLI invocation is
//   a fresh process, so the file is the cross-invocation persistence layer).
// Tests: always starts empty; clearTokenStore() resets between test cases.
// ---------------------------------------------------------------------------

let _inMemory: Map<string, TokenRecord> | null = null;

function getStore(): Map<string, TokenRecord> {
  if (_inMemory !== null) return _inMemory;
  if (IS_TEST) {
    _inMemory = new Map();
    return _inMemory;
  }
  // Production: lazy-load from file
  if (!existsSync(TOKEN_STORE_PATH)) {
    _inMemory = new Map();
    return _inMemory;
  }
  try {
    const data = JSON.parse(readFileSync(TOKEN_STORE_PATH, "utf-8")) as Record<string, TokenRecord>;
    _inMemory = new Map(Object.entries(data));
  } catch {
    _inMemory = new Map();
  }
  return _inMemory;
}

function persistStore(): void {
  if (IS_TEST) return; // Never write to ~/.mantle during tests
  const map = _inMemory;
  if (map === null) return;
  ensureStoreDir();
  const obj: Record<string, TokenRecord> = {};
  for (const [k, v] of map) obj[k] = v;
  writeFileSync(TOKEN_STORE_PATH, JSON.stringify(obj, null, 2), {
    encoding: "utf-8",
    mode: 0o600
  });
}

// ---------------------------------------------------------------------------
// Test isolation helpers (exported for use in beforeEach)
// ---------------------------------------------------------------------------

/** Reset all tokens from the in-memory store. Call in beforeEach for isolation. */
export function clearTokenStore(): void {
  _inMemory = new Map();
}

/** Return the number of live tokens in the active store. */
export function getTokenStoreSize(): number {
  return getStore().size;
}

/**
 * Resolve the execution mode from CLI option flags.
 *
 * @throws if both --dry-run and --confirm are set simultaneously.
 */
export function resolveExecutionMode(opts: {
  dryRun?: boolean;
  confirm?: boolean;
}): "dry-run" | "confirm" {
  if (opts.dryRun && opts.confirm) {
    throw new Error("--dry-run and --confirm are mutually exclusive. Use one or the other.");
  }
  return opts.confirm ? "confirm" : "dry-run";
}

// ---------------------------------------------------------------------------
// Filesystem helpers (production only)
// ---------------------------------------------------------------------------

function ensureStoreDir(): void {
  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  }
}

function loadSecret(): string {
  if (IS_TEST) return "test-secret-for-unit-tests-only-not-persisted";
  ensureStoreDir();
  if (existsSync(SECRET_PATH)) {
    return readFileSync(SECRET_PATH, "utf-8").trim();
  }
  const secret = randomBytes(32).toString("hex");
  // O_EXCL avoids TOCTOU: if two processes race to create the secret, the
  // loser gets EEXIST and reads the winner's secret instead of overwriting it.
  try {
    writeFileSync(SECRET_PATH, secret, { encoding: "utf-8", flag: "wx" as never, mode: 0o600 });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return readFileSync(SECRET_PATH, "utf-8").trim();
    }
    throw err;
  }
  return secret;
}

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

/**
 * Compute an HMAC-SHA-256 token for the given commandHash.
 * Token format: mntl_ + 8-char nonce + 24-char HMAC-slice = 37 chars total.
 */
function makeToken(commandHash: string, secret: string): string {
  const nonce = randomBytes(4).toString("hex"); // 4 bytes = 8 hex chars
  const hmac = createHmac("sha256", secret)
    .update(`${commandHash}:${nonce}`)
    .digest("hex")
    .slice(0, 24); // 24 hex chars → total 32 hex chars after prefix
  return `${TOKEN_PREFIX}${nonce}${hmac}`;
}

export interface GeneratedToken {
  /** Confirmation token string (mntl_ + 32 hex chars). */
  confirmation_token: string;
  /** ISO-8601 expiry timestamp. */
  expires_at: string;
}

/**
 * Generate a confirmation token and persist it.
 * Automatically prunes expired tokens on each call.
 *
 * @param params - Command parameters to hash, or a pre-computed hash string.
 * @param ttlMs  - Token lifetime in ms. Override in tests for fast expiry checks.
 */
export function generateConfirmationToken(
  params: Record<string, unknown> | string,
  ttlMs = TOKEN_TTL_MS
): GeneratedToken {
  const commandHash = typeof params === "string" ? params : buildCommandHash(params);
  const secret = loadSecret();
  const now = Date.now();
  const store = getStore();

  // Prune expired entries
  for (const [tok, rec] of store.entries()) {
    if (rec.expiresAt <= now) store.delete(tok);
  }

  const token = makeToken(commandHash, secret);
  const expiresAt = now + ttlMs;
  store.set(token, { commandHash, expiresAt });
  persistStore();

  return {
    confirmation_token: token,
    expires_at: new Date(expiresAt).toISOString()
  };
}

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

/**
 * Validate a confirmation token and consume it (single-use).
 *
 * The token is consumed (deleted) on success, on expiry, AND on hash-mismatch —
 * the last case prevents unlimited hash-probing against a known token string.
 *
 * @param token  - The confirmation token string.
 * @param params - Original command params (or pre-computed hash string).
 * @throws {Error} with a descriptive message on any validation failure.
 */
export function validateConfirmationToken(
  token: string,
  params: Record<string, unknown> | string
): void {
  // Format check before touching the store
  if (!TOKEN_REGEX.test(token)) {
    throw new Error(
      "Invalid confirmation token format. Expected mntl_ followed by 32 hex characters."
    );
  }

  const commandHash = typeof params === "string" ? params : buildCommandHash(params);
  const store = getStore();
  const now = Date.now();
  const record = store.get(token);

  if (!record) {
    throw new Error(
      "Confirmation token not found or already used. " +
      'Run the same command with "--dry-run" first to obtain a valid token.'
    );
  }

  if (record.expiresAt <= now) {
    store.delete(token);
    persistStore();
    throw new Error(
      "Confirmation token has expired (tokens are valid for 5 minutes). " +
      'Run the command again with "--dry-run" to get a fresh token.'
    );
  }

  if (record.commandHash !== commandHash) {
    // Consume on mismatch to prevent unlimited hash probing
    store.delete(token);
    persistStore();
    throw new Error(
      "Confirmation token does not match the command parameters. " +
      'Run the exact same command with "--dry-run" to get a matching token.'
    );
  }

  // Consume the token (single-use)
  store.delete(token);
  persistStore();
}

// ---------------------------------------------------------------------------
// Command hash helpers
// ---------------------------------------------------------------------------

/**
 * Keys excluded from command hashing — set at build/quote time and do not
 * reflect user intent. Including them would cause hash mismatches when the
 * same logical command produces a slightly different timestamp on dry-run vs confirm.
 */
const EPHEMERAL_KEYS = new Set(["built_at_utc", "quoted_at_utc"]);

/**
 * Produce a deterministic SHA-256 hash from a set of key-value pairs.
 * Sorts keys alphabetically, filters null/undefined and ephemeral timestamps.
 */
export function buildCommandHash(params: Record<string, unknown>): string {
  const normalized = Object.fromEntries(
    Object.entries(params)
      .filter(([k, v]) => v !== undefined && v !== null && !EPHEMERAL_KEYS.has(k))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, String(v)])
  );
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 32);
}
