/**
 * assert — lightweight assertion helpers for the signing test suite.
 */

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

export function assertDefined<T>(
  value: T | undefined | null,
  label: string
): asserts value is T {
  if (value === undefined || value === null) {
    throw new Error(`${label} is ${value}`);
  }
}

export function assertIncludes(haystack: string, needle: string, label: string) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label}: "${haystack}" does not include "${needle}"`);
  }
}

export function assertGreaterThan(actual: number | bigint, threshold: number | bigint, label: string) {
  if (actual <= threshold) {
    throw new Error(`${label}: expected > ${threshold}, got ${actual}`);
  }
}
