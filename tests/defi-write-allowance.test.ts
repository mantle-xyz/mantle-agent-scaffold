import { describe, expect, it } from "vitest";
import {
  buildApprove,
  buildSwap,
  buildAddLiquidity
} from "@mantleio/mantle-core/tools/defi-write.js";
import { MantleMcpError } from "@mantleio/mantle-core/errors.js";

// ---------------------------------------------------------------------------
// Tests cover the PR "fix/swap-approve-flow" behavior change:
//   - Insufficient ERC-20 allowance must now THROW (not warn) so the agent
//     never signs a swap/add-liquidity that would revert on-chain with STF.
//   - `err.code === "INSUFFICIENT_ALLOWANCE"` and the metadata (spender,
//     required, current_allowance, owner) must be populated.
//   - For buildAddLiquidity: Promise.allSettled must not mask a known-
//     insufficient allowance when the *other* token's RPC read fails.
// ---------------------------------------------------------------------------

const OWNER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";

const USDC_MAINNET = {
  address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
  symbol: "USDC",
  decimals: 6
};
const USDT_MAINNET = {
  address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
  symbol: "USDT",
  decimals: 6
};
const WMNT_MAINNET = {
  address: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
  symbol: "WMNT",
  decimals: 18
};

function mapToken(input: string) {
  const t = input.toUpperCase();
  if (t === "USDC") return USDC_MAINNET;
  if (t === "USDT") return USDT_MAINNET;
  if (t === "WMNT") return WMNT_MAINNET;
  throw new Error(`Unknown test token: ${input}`);
}

describe("buildSwap INSUFFICIENT_ALLOWANCE throw path", () => {
  it("throws MantleMcpError when owner allowance < amount_in", async () => {
    let readCount = 0;
    try {
      await buildSwap(
        {
          provider: "agni",
          token_in: "USDC",
          token_out: "USDT",
          amount_in: "100",
          amount_out_min: "99000000",
          recipient: RECIPIENT,
          owner: OWNER,
          network: "mainnet"
        },
        {
          resolveTokenInput: async (input: string) => mapToken(input),
          // allowance = 10 USDC raw (< 100 USDC required) → must throw
          getClient: () => ({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            readContract: async () => { readCount++; return 10_000000n; }
          }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
      throw new Error("expected buildSwap to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MantleMcpError);
      const e = err as MantleMcpError;
      expect(e.code).toBe("INSUFFICIENT_ALLOWANCE");
      const meta = e.details as Record<string, unknown>;
      expect(meta.token).toBe("USDC");
      expect(meta.owner).toBe(OWNER);
      expect(meta.required).toBe("100");
      expect(meta.current_allowance).toBe("10");
      expect(typeof meta.spender).toBe("string");
      expect(readCount).toBe(1);
    }
  });

  it("proceeds past the check when allowance >= amount_in (no throw here)", async () => {
    // We don't care about the downstream happy path — just assert that an
    // INSUFFICIENT_ALLOWANCE is NOT raised when allowance is sufficient.
    let sawInsufficient = false;
    try {
      await buildSwap(
        {
          provider: "agni",
          token_in: "USDC",
          token_out: "USDT",
          amount_in: "100",
          amount_out_min: "99000000",
          recipient: RECIPIENT,
          owner: OWNER,
          network: "mainnet"
        },
        {
          resolveTokenInput: async (input: string) => mapToken(input),
          // allowance = 1000 USDC raw (>= 100 USDC required) → must NOT throw here
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getClient: () => ({ readContract: async () => 1000_000000n }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
    } catch (err) {
      if (err instanceof MantleMcpError && err.code === "INSUFFICIENT_ALLOWANCE") {
        sawInsufficient = true;
      }
      // Any other error (e.g. downstream quote/pool resolution) is fine.
    }
    expect(sawInsufficient).toBe(false);
  });

  it("does NOT throw INSUFFICIENT_ALLOWANCE when owner is omitted (check skipped)", async () => {
    let sawInsufficient = false;
    try {
      await buildSwap(
        {
          provider: "agni",
          token_in: "USDC",
          token_out: "USDT",
          amount_in: "100",
          amount_out_min: "99000000",
          recipient: RECIPIENT,
          // no `owner` — allowance check must be skipped entirely
          network: "mainnet"
        },
        {
          resolveTokenInput: async (input: string) => mapToken(input),
          // readContract would return 0 — but it should never be called
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getClient: () => ({ readContract: async () => 0n }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
    } catch (err) {
      if (err instanceof MantleMcpError && err.code === "INSUFFICIENT_ALLOWANCE") {
        sawInsufficient = true;
      }
    }
    expect(sawInsufficient).toBe(false);
  });

  it("narrows catch re-throw to INSUFFICIENT_ALLOWANCE only (unrelated RPC errors swallowed)", async () => {
    // If readContract throws a generic RPC error, the allowance check must
    // swallow it and proceed (best-effort). We assert no INSUFFICIENT_ALLOWANCE
    // leaks out of the check in that case.
    let sawInsufficient = false;
    try {
      await buildSwap(
        {
          provider: "agni",
          token_in: "USDC",
          token_out: "USDT",
          amount_in: "100",
          amount_out_min: "99000000",
          recipient: RECIPIENT,
          owner: OWNER,
          network: "mainnet"
        },
        {
          resolveTokenInput: async (input: string) => mapToken(input),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getClient: () => ({ readContract: async () => { throw new Error("rpc down"); } }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
    } catch (err) {
      if (err instanceof MantleMcpError && err.code === "INSUFFICIENT_ALLOWANCE") {
        sawInsufficient = true;
      }
    }
    expect(sawInsufficient).toBe(false);
  });
});

const FAKE_LB_PAIR = "0x0000000000000000000000000000000000001234";

describe("buildAddLiquidity INSUFFICIENT_ALLOWANCE throw path", () => {
  it("throws when tokenA allowance is insufficient (LB provider, both reads fulfilled)", async () => {
    try {
      await buildAddLiquidity(
        {
          provider: "merchant_moe",
          token_a: "USDC",
          token_b: "WMNT",
          amount_a: "1000",
          amount_b: "1",
          recipient: RECIPIENT,
          owner: OWNER,
          network: "mainnet"
        },
        {
          resolveTokenInput: async (input: string) => mapToken(input),
          getClient: () => ({
            readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
              // LB Factory / Pair on-chain reads for buildMoeAddLiquidity
              if (functionName === "getLBPairInformation") {
                return { binStep: 25, LBPair: FAKE_LB_PAIR, createdByOwner: false, ignoredForRouting: false };
              }
              if (functionName === "getActiveId") return 8388608;
              if (functionName === "getTokenX") return USDC_MAINNET.address;
              // ERC-20 allowance: USDC insufficient (required 1000, has 5); WMNT plenty.
              if (address.toLowerCase() === USDC_MAINNET.address.toLowerCase()) return 5_000000n;
              return 1_000_000_000000000000000000n;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
      throw new Error("expected buildAddLiquidity to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MantleMcpError);
      const e = err as MantleMcpError;
      expect(e.code).toBe("INSUFFICIENT_ALLOWANCE");
      const meta = e.details as Record<string, unknown>;
      expect(meta.token).toBe("USDC");
      expect(meta.required).toBe("1000");
    }
  });

  it("Promise.allSettled still throws when tokenA is known-insufficient even if tokenB read REJECTS", async () => {
    // This is the F-5 regression test: the pre-PR Promise.all pattern would
    // swallow the known-insufficient allowance whenever the *other* token's
    // RPC read rejected (e.g. non-standard ERC-20). allSettled must preserve
    // the throw for the fulfilled-but-insufficient side.
    try {
      await buildAddLiquidity(
        {
          provider: "merchant_moe",
          token_a: "USDC",
          token_b: "WMNT",
          amount_a: "1000",
          amount_b: "1",
          recipient: RECIPIENT,
          owner: OWNER,
          network: "mainnet"
        },
        {
          resolveTokenInput: async (input: string) => mapToken(input),
          getClient: () => ({
            readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
              // LB Factory / Pair on-chain reads for buildMoeAddLiquidity
              if (functionName === "getLBPairInformation") {
                return { binStep: 25, LBPair: FAKE_LB_PAIR, createdByOwner: false, ignoredForRouting: false };
              }
              if (functionName === "getActiveId") return 8388608;
              if (functionName === "getTokenX") return USDC_MAINNET.address;
              // ERC-20 allowance: USDC insufficient; WMNT rejects (non-standard ERC-20)
              if (address.toLowerCase() === USDC_MAINNET.address.toLowerCase()) return 5_000000n;
              throw new Error("WMNT non-standard ERC-20 rejected");
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
      throw new Error("expected buildAddLiquidity to throw INSUFFICIENT_ALLOWANCE even when the other read rejects");
    } catch (err) {
      expect(err).toBeInstanceOf(MantleMcpError);
      expect((err as MantleMcpError).code).toBe("INSUFFICIENT_ALLOWANCE");
    }
  });

  it("allowance check works correctly when tokenB is the canonical tokenX (B-is-X sort path)", async () => {
    // When getTokenX returns WMNT (tokenB), the sort branch assigns tokenB as X.
    // The allowance check must still fire against the pre-sort tokenA (USDC) with
    // the correct required amount, confirming the sort doesn't corrupt amounts.
    try {
      await buildAddLiquidity(
        {
          provider: "merchant_moe",
          token_a: "USDC",
          token_b: "WMNT",
          amount_a: "1000",
          amount_b: "1",
          recipient: RECIPIENT,
          owner: OWNER,
          network: "mainnet"
        },
        {
          resolveTokenInput: async (input: string) => mapToken(input),
          getClient: () => ({
            readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
              if (functionName === "getLBPairInformation") {
                return { binStep: 25, LBPair: FAKE_LB_PAIR, createdByOwner: false, ignoredForRouting: false };
              }
              if (functionName === "getActiveId") return 8388608;
              // Return WMNT as tokenX — exercises the B-is-X branch
              if (functionName === "getTokenX") return WMNT_MAINNET.address;
              // USDC insufficient; WMNT plenty
              if (address.toLowerCase() === USDC_MAINNET.address.toLowerCase()) return 5_000000n;
              return 1_000_000_000000000000000000n;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
      throw new Error("expected buildAddLiquidity to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MantleMcpError);
      const e = err as MantleMcpError;
      expect(e.code).toBe("INSUFFICIENT_ALLOWANCE");
      const meta = e.details as Record<string, unknown>;
      // USDC is tokenA (pre-sort), required amount should still be 1000
      expect(meta.token).toBe("USDC");
      expect(meta.required).toBe("1000");
    }
  });

  it("throws POOL_NOT_FOUND when factory returns zero-address pair", async () => {
    try {
      await buildAddLiquidity(
        {
          provider: "merchant_moe",
          token_a: "USDC",
          token_b: "WMNT",
          amount_a: "1000",
          amount_b: "1",
          recipient: RECIPIENT,
          network: "mainnet"
        },
        {
          resolveTokenInput: async (input: string) => mapToken(input),
          getClient: () => ({
            readContract: async ({ functionName }: { functionName: string }) => {
              if (functionName === "getLBPairInformation") {
                return { binStep: 25, LBPair: "0x0000000000000000000000000000000000000000", createdByOwner: false, ignoredForRouting: false };
              }
              return 0n;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
      throw new Error("expected buildAddLiquidity to throw POOL_NOT_FOUND");
    } catch (err) {
      expect(err).toBeInstanceOf(MantleMcpError);
      expect((err as MantleMcpError).code).toBe("POOL_NOT_FOUND");
    }
  });
});

// ---------------------------------------------------------------------------
// buildApprove: balance pre-check (advisory warning, not a hard block)
//
// ERC-20 approve() has no on-chain requirement that amount ≤ balance. The
// balance check only happens at transferFrom() time. Pre-approving more than
// the current balance is a legitimate pattern (forward approvals, approve-then-
// fund, round-number approvals). We surface a warning, not an error.
// ---------------------------------------------------------------------------

// Agni SwapRouter — whitelisted spender so buildApprove does not reject on
// SPENDER_NOT_WHITELISTED before reaching the balance check.
const AGNI_ROUTER = "0x319B69888b0d11cEC22caA5034e25FfFBDc88421";

describe("buildApprove balance advisory warning", () => {
  it("emits a balance warning (not a throw) when owner balance < approve amount", async () => {
    const result = await buildApprove(
      {
        token: "USDC",
        spender: AGNI_ROUTER,
        amount: "100",
        owner: OWNER,
        network: "mainnet"
      },
      {
        resolveTokenInput: async (input: string) => mapToken(input),
        getClient: () => ({
          // First read = allowance (0 — insufficient, so skip does not fire),
          // second read = balance (10 USDC raw — below the 100 requested).
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          readContract: async ({ functionName }: { functionName: string }) => {
            if (functionName === "allowance") return 0n;
            if (functionName === "balanceOf") return 10_000000n;
            return 0n;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
        now: () => "2026-04-18T00:00:00.000Z",
        deadline: () => 1_800_000_000n
      }
    );
    // Approve is built successfully — no throw.
    expect(result.intent).toBe("approve");
    expect(result.unsigned_tx.data).not.toBe("0x");
    // A balance advisory warning is present.
    expect(result.warnings.some(w => w.includes("10") && w.includes("100"))).toBe(true);
  });

  it("does NOT throw when balance >= amount (and allowance is 0 — tx is built)", async () => {
    const result = await buildApprove(
      {
        token: "USDC",
        spender: AGNI_ROUTER,
        amount: "100",
        owner: OWNER,
        network: "mainnet"
      },
      {
        resolveTokenInput: async (input: string) => mapToken(input),
        getClient: () => ({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          readContract: async ({ functionName }: { functionName: string }) => {
            if (functionName === "allowance") return 0n;
            if (functionName === "balanceOf") return 500_000000n; // 500 USDC
            return 0n;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
        now: () => "2026-04-18T00:00:00.000Z",
        deadline: () => 1_800_000_000n
      }
    );
    // A real approve tx is built (not a skip) and calldata is populated.
    expect(result.intent).toBe("approve");
    expect(result.unsigned_tx.data).not.toBe("0x");
    // No balance advisory warning when balance is sufficient.
    expect(result.warnings.every((w: string) => !w.includes("balance for"))).toBe(true);
  });

  it("is exempt when amount='max' — unlimited pre-approval is intentional, balance 0 is fine", async () => {
    // "max" is a deliberate forward-looking approval (e.g. reusing the same
    // allowance for future top-ups). We refuse to gate it on current balance.
    const result = await buildApprove(
      {
        token: "USDC",
        spender: AGNI_ROUTER,
        amount: "max",
        owner: OWNER,
        network: "mainnet"
      },
      {
        resolveTokenInput: async (input: string) => mapToken(input),
        getClient: () => ({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          readContract: async ({ functionName }: { functionName: string }) => {
            if (functionName === "allowance") return 0n;
            if (functionName === "balanceOf") return 0n; // zero balance
            return 0n;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
        now: () => "2026-04-18T00:00:00.000Z",
        deadline: () => 1_800_000_000n
      }
    );
    expect(result.intent).toBe("approve");
    // unlimited approvals surface a generic security warning — assert it's present
    expect(result.warnings.some(w => w.toLowerCase().includes("unlimited"))).toBe(true);
  });

  it("is skipped when owner is omitted — cannot read balance, so cannot block", async () => {
    // Matches the allowance-check-skipped semantics: no owner → no pre-checks.
    const result = await buildApprove(
      {
        token: "USDC",
        spender: AGNI_ROUTER,
        amount: "100",
        network: "mainnet"
        // no `owner`
      },
      {
        resolveTokenInput: async (input: string) => mapToken(input),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getClient: () => ({ readContract: async () => 0n }) as any,
        now: () => "2026-04-18T00:00:00.000Z",
        deadline: () => 1_800_000_000n
      }
    );
    expect(result.intent).toBe("approve");
  });

  it("does NOT emit a balance warning when the balanceOf RPC read rejects (fail-open policy)", async () => {
    // Fail-open: if we cannot read the balance, we cannot prove a shortfall,
    // so we do not emit a balance advisory warning. The downstream tx may
    // still revert — that is explicitly accepted as the less-bad outcome vs.
    // blocking operations during an RPC outage.
    const result = await buildApprove(
      {
        token: "USDC",
        spender: AGNI_ROUTER,
        amount: "100",
        owner: OWNER,
        network: "mainnet"
      },
      {
        resolveTokenInput: async (input: string) => mapToken(input),
        getClient: () => ({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          readContract: async ({ functionName }: { functionName: string }) => {
            if (functionName === "allowance") return 0n;
            if (functionName === "balanceOf") throw new Error("rpc down");
            return 0n;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
        now: () => "2026-04-18T00:00:00.000Z",
        deadline: () => 1_800_000_000n
      }
    );
    // Approve is built successfully — fail-open means no blocking.
    expect(result.intent).toBe("approve");
    // No balance advisory warning when balance is unknown.
    expect(result.warnings.every((w: string) => !w.toLowerCase().includes("balance for"))).toBe(true);
  });

  it("emits a balance warning when allowance RPC rejects but balanceOf proves balance is short", async () => {
    // Core value of Promise.allSettled in this builder: the two reads are
    // independent. If the allowance read rejects but balanceOf fulfills and
    // shows balance < amount, we surface a warning (not a throw — approve is
    // still valid on-chain).
    const result = await buildApprove(
      {
        token: "USDC",
        spender: AGNI_ROUTER,
        amount: "100",
        owner: OWNER,
        network: "mainnet"
      },
      {
        resolveTokenInput: async (input: string) => mapToken(input),
        getClient: () => ({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          readContract: async ({ functionName }: { functionName: string }) => {
            if (functionName === "allowance") throw new Error("allowance rpc down");
            if (functionName === "balanceOf") return 10_000000n; // 10 USDC (< 100 required)
            return 0n;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
        now: () => "2026-04-18T00:00:00.000Z",
        deadline: () => 1_800_000_000n
      }
    );
    // Approve is built — no throw despite balance being short.
    expect(result.intent).toBe("approve");
    // Balance advisory warning surfaces both figures.
    expect(result.warnings.some(w => w.includes("10") && w.includes("100"))).toBe(true);
    // Suggestion points to the correct ERC-20 read tool.
    expect(result.warnings.some(w => w.includes("mantle_getTokenBalances"))).toBe(true);
  });

  it("returns approve_skip with a balance warning when allowance is sufficient but balance is short", async () => {
    // Allowance is already sufficient → approve_skip fires (no new tx needed).
    // Balance is short → a balance advisory warning is appended to the skip result
    // so the agent can surface the funding gap before the follow-up swap.
    const result = await buildApprove(
      {
        token: "USDC",
        spender: AGNI_ROUTER,
        amount: "100",
        owner: OWNER,
        network: "mainnet"
      },
      {
        resolveTokenInput: async (input: string) => mapToken(input),
        getClient: () => ({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          readContract: async ({ functionName }: { functionName: string }) => {
            // already-unlimited allowance
            if (functionName === "allowance") {
              return BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
            }
            if (functionName === "balanceOf") return 10_000000n;
            return 0n;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
        now: () => "2026-04-18T00:00:00.000Z",
        deadline: () => 1_800_000_000n
      }
    );
    // Allowance is sufficient → skip (no new tx).
    expect(result.intent).toBe("approve_skip");
    // Balance warning is still surfaced.
    expect(result.warnings.some(w => w.includes("10") && w.includes("100"))).toBe(true);
  });
});
