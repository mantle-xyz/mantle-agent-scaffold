/**
 * Structured audit logger for MCP tool invocations.
 *
 * Emits one JSON line per event to **stderr** (MCP uses stdout for the
 * JSON-RPC transport, so all diagnostic / audit output MUST go to stderr).
 *
 * Each log entry contains:
 *   - tool_name   – the MCP tool that was called
 *   - input       – the arguments supplied by the caller (sensitive keys redacted)
 *   - agent_id    – extracted from `_meta.agent_id` when available
 *   - session_id  – extracted from `_meta.session_id` when available
 *   - timestamp   – ISO-8601 UTC timestamp
 *   - duration_ms – wall-clock execution time
 *   - success     – whether the handler resolved without throwing
 *   - error_code  – short error code when the call failed (null on success)
 */

export interface AuditEntry {
  tool_name: string;
  input: Record<string, unknown>;
  agent_id: string | null;
  session_id: string | null;
  timestamp: string;
  duration_ms: number;
  success: boolean;
  error_code: string | null;
}

/* ------------------------------------------------------------------ */
/*  Sensitive-key scrubber                                            */
/* ------------------------------------------------------------------ */

const SENSITIVE_KEYS = new Set([
  "private_key",
  "privatekey",
  "mnemonic",
  "seed",
  "seed_phrase",
  "secret",
  "password",
  "api_key",
  "apikey",
  "token",
  "auth",
  "authorization",
  "credential"
]);

function scrubInput(input: Record<string, unknown>): Record<string, unknown> {
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "_meta") continue; // stripped — already extracted into structured fields
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      scrubbed[key] = "[REDACTED]";
    } else {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
}

/**
 * Extract optional metadata that MCP clients may attach via `_meta`,
 * and return the remaining args with `_meta` stripped.
 */
export function extractMeta(
  args: Record<string, unknown>
): { agent_id: string | null; session_id: string | null; loggableArgs: Record<string, unknown> } {
  const meta =
    args._meta && typeof args._meta === "object" ? (args._meta as Record<string, unknown>) : null;
  return {
    agent_id: typeof meta?.agent_id === "string" ? meta.agent_id : null,
    session_id: typeof meta?.session_id === "string" ? meta.session_id : null,
    loggableArgs: scrubInput(args)
  };
}

/**
 * JSON replacer that handles bigint (converts to string) to prevent
 * `TypeError: Do not know how to serialize a BigInt`.
 */
function safeReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Write a structured audit entry to stderr as a single JSON line.
 */
export function writeAuditLog(entry: AuditEntry): void {
  try {
    process.stderr.write(JSON.stringify(entry, safeReplacer) + "\n");
  } catch (err) {
    // Last-resort: write a minimal failure record so audit gaps are visible.
    try {
      process.stderr.write(
        JSON.stringify({
          tool_name: entry.tool_name,
          timestamp: entry.timestamp,
          audit_log_error: String(err)
        }) + "\n"
      );
    } catch {
      // Truly unrecoverable — never let audit logging break the server.
    }
  }
}
