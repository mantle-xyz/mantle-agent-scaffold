import { InvalidArgumentError } from "commander";
import { MantleMcpError } from "@mantleio/mantle-core/errors.js";

export function parseCommaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parseJsonString(value: string, fieldName: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `${fieldName} must be valid JSON object.`,
      `Provide ${fieldName} as a JSON string, e.g. '{"key":"value"}'.`,
      { field: fieldName, value }
    );
  }
}

export function applyRpcOverride(rpcUrl: string | undefined, network: string): void {
  if (!rpcUrl) return;
  if (network === "sepolia") {
    process.env.MANTLE_SEPOLIA_RPC_URL = rpcUrl;
  } else {
    process.env.MANTLE_RPC_URL = rpcUrl;
  }
}

export function parseJsonArray(value: string, fieldName: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error("Expected a JSON array");
    }
    return parsed;
  } catch {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `${fieldName} must be a valid JSON array.`,
      `Provide ${fieldName} as a JSON string, e.g. '[1, "0x..."]'.`,
      { field: fieldName, value }
    );
  }
}

/**
 * Parse a JSON-style array of integer literals while preserving BigInt
 * precision. Returns each element as a digit string so that callers can
 * safely do `BigInt(item)` without the IEEE-754 rounding that `JSON.parse`
 * would otherwise introduce for values above `Number.MAX_SAFE_INTEGER`.
 *
 * Used for inputs like LB-token `--amounts` in `lp remove`, where values
 * are commonly 10^17+ and would be silently corrupted by a plain
 * `JSON.parse`.
 */
export function parseBigIntArray(value: string, fieldName: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `${fieldName} must be a JSON array of integers.`,
      `Provide ${fieldName} as '[123, 456]'.`,
      { field: fieldName, value }
    );
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return [];
  const parts = inner.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  for (const p of parts) {
    // Allow optional surrounding quotes so `["123", "456"]` also works.
    const unquoted =
      (p.startsWith('"') && p.endsWith('"')) ||
      (p.startsWith("'") && p.endsWith("'"))
        ? p.slice(1, -1)
        : p;
    if (!/^-?\d+$/.test(unquoted)) {
      throw new MantleMcpError(
        "INVALID_INPUT",
        `${fieldName} must be a JSON array of integers (got non-integer element '${p}').`,
        `Each element of ${fieldName} must be an integer literal.`,
        { field: fieldName, value }
      );
    }
  }
  // Strip any surrounding quotes in the returned digit strings.
  return parts.map((p) =>
    (p.startsWith('"') && p.endsWith('"')) ||
    (p.startsWith("'") && p.endsWith("'"))
      ? p.slice(1, -1)
      : p
  );
}

export function parseIntegerOption(value: string, optionName: string): number {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new InvalidArgumentError(`${optionName} must be a valid integer.`);
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError(`${optionName} must be a safe integer.`);
  }
  return parsed;
}

export function parseNumberOption(value: string, optionName: string): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError(`${optionName} must be a valid number.`);
  }
  return parsed;
}
