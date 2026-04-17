import { describe, expect, it, beforeEach } from "vitest";
import {
  generateConfirmationToken,
  validateConfirmationToken,
  clearTokenStore,
  getTokenStoreSize,
  resolveExecutionMode
} from "../packages/cli/src/confirmation-token.js";

describe("confirmation-token", () => {
  beforeEach(() => {
    clearTokenStore();
  });

  it("generates a token with mntl_ prefix and expiry", () => {
    const params = { provider: "agni", token_in: "WMNT", amount: "10" };
    const result = generateConfirmationToken(params);

    expect(result.confirmation_token).toMatch(/^mntl_[a-f0-9]{32}$/);
    expect(result.expires_at).toBeTruthy();
    expect(new Date(result.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(getTokenStoreSize()).toBe(1);
  });

  it("validates and consumes a valid token (single-use)", () => {
    const params = { provider: "agni", token_in: "WMNT", amount: "10" };
    const { confirmation_token } = generateConfirmationToken(params);

    // First validation succeeds and consumes the token
    expect(() => validateConfirmationToken(confirmation_token, params)).not.toThrow();
    expect(getTokenStoreSize()).toBe(0);

    // Second validation fails — token was consumed
    expect(() => validateConfirmationToken(confirmation_token, params)).toThrow(
      /not found or already used/
    );
  });

  it("rejects an invalid token format", () => {
    const params = { provider: "agni" };
    expect(() => validateConfirmationToken("bad_token", params)).toThrow(
      /Invalid confirmation token format/
    );
  });

  it("rejects a non-existent token", () => {
    const params = { provider: "agni" };
    expect(() => validateConfirmationToken("mntl_0000000000000000000000000000dead", params)).toThrow(
      /not found or already used/
    );
  });

  it("rejects an expired token", async () => {
    const params = { provider: "agni", token_in: "WMNT" };
    // Generate with a 1ms TTL so it expires immediately
    const { confirmation_token } = generateConfirmationToken(params, 1);

    // Wait a bit for expiry
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(() => validateConfirmationToken(confirmation_token, params)).toThrow(
      /expired/
    );
  });

  it("rejects a token when build params differ", () => {
    const params1 = { provider: "agni", token_in: "WMNT", amount: "10" };
    const params2 = { provider: "agni", token_in: "WMNT", amount: "20" };
    const { confirmation_token } = generateConfirmationToken(params1);

    expect(() => validateConfirmationToken(confirmation_token, params2)).toThrow(
      /does not match/
    );
    // Token should be consumed on mismatch too
    expect(getTokenStoreSize()).toBe(0);
  });

  it("ignores ephemeral keys (built_at_utc, quoted_at_utc) in param hashing", () => {
    const params1 = { provider: "agni", token_in: "WMNT", built_at_utc: "2025-01-01" };
    const params2 = { provider: "agni", token_in: "WMNT", built_at_utc: "2025-06-01" };
    const { confirmation_token } = generateConfirmationToken(params1);

    // Should succeed because built_at_utc is excluded from the hash
    expect(() => validateConfirmationToken(confirmation_token, params2)).not.toThrow();
  });

  it("generates unique tokens for the same params", () => {
    const params = { provider: "agni", token_in: "WMNT" };
    const t1 = generateConfirmationToken(params);
    const t2 = generateConfirmationToken(params);

    expect(t1.confirmation_token).not.toBe(t2.confirmation_token);
    expect(getTokenStoreSize()).toBe(2);
  });

  it("prunes expired tokens on generation", async () => {
    const params = { provider: "agni" };
    // Generate a token that expires in 1ms
    generateConfirmationToken(params, 1);
    expect(getTokenStoreSize()).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Generating a new token prunes the expired one
    generateConfirmationToken(params, 300000);
    expect(getTokenStoreSize()).toBe(1); // only the new one
  });

  // ── resolveExecutionMode ─────────────────────────────────────────────

  it("resolveExecutionMode defaults to dry-run when neither flag is set", () => {
    expect(resolveExecutionMode({})).toBe("dry-run");
  });

  it("resolveExecutionMode returns confirm when confirm is true", () => {
    expect(resolveExecutionMode({ confirm: true })).toBe("confirm");
  });

  it("resolveExecutionMode returns dry-run when dryRun is true", () => {
    expect(resolveExecutionMode({ dryRun: true })).toBe("dry-run");
  });

  it("resolveExecutionMode throws on --dry-run + --confirm", () => {
    expect(() => resolveExecutionMode({ dryRun: true, confirm: true })).toThrow(
      /mutually exclusive/
    );
  });
});
