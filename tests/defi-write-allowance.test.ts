import { describe, expect, it } from "vitest";
import {
  buildSwap,
  buildAddLiquidity,
  buildWrapMnt,
  buildUnwrapMnt,
  buildAaveSupply,
  buildAaveRepay,
  buildAaveWithdraw
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
// INSUFFICIENT_BALANCE tests
// ---------------------------------------------------------------------------

describe("buildSwap INSUFFICIENT_BALANCE throw path", () => {
  it("throws INSUFFICIENT_BALANCE when owner balance < amount_in (allowance is sufficient)", async () => {
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
          getClient: () => ({
            readContract: async ({ functionName }: { functionName: string }) => {
              if (functionName === "allowance") return 1_000_000_000_000n; // sufficient
              if (functionName === "balanceOf") return 0n;                 // zero balance → throw
              return 0n;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
      throw new Error("expected buildSwap to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MantleMcpError);
      const e = err as MantleMcpError;
      expect(e.code).toBe("INSUFFICIENT_BALANCE");
      const meta = e.details as Record<string, unknown>;
      expect(meta.token).toBe("USDC");
      expect(meta.owner).toBe(OWNER);
      expect(meta.required).toBe("100");
      expect(meta.current_balance).toBe("0");
    }
  });

  it("does NOT throw INSUFFICIENT_BALANCE when owner is omitted (balance check skipped)", async () => {
    // Guard condition: balance check is gated by `if (swapOwner)`. When owner is absent,
    // the check must not fire — even if balanceOf would return 0 — to avoid false blocks.
    let sawBalanceError = false;
    try {
      await buildSwap(
        {
          provider: "agni",
          token_in: "USDC",
          token_out: "USDT",
          amount_in: "100",
          amount_out_min: "99000000",
          recipient: RECIPIENT,
          // owner intentionally omitted
          network: "mainnet"
        },
        {
          resolveTokenInput: async (input: string) => mapToken(input),
          getClient: () => ({
            readContract: async () => 0n  // balanceOf = 0, allowance = 0 — both skipped without owner
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
    } catch (err) {
      if (err instanceof MantleMcpError && err.code === "INSUFFICIENT_BALANCE") {
        sawBalanceError = true;
      }
    }
    expect(sawBalanceError).toBe(false);
  });
});

describe("buildWrapMnt INSUFFICIENT_BALANCE throw path", () => {
  it("throws INSUFFICIENT_BALANCE when sender native MNT balance < amount", async () => {
    try {
      await buildWrapMnt(
        { amount: "10", sender: OWNER, network: "mainnet" },
        {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getClient: () => ({ getBalance: async () => 0n }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
      throw new Error("expected buildWrapMnt to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MantleMcpError);
      const e = err as MantleMcpError;
      expect(e.code).toBe("INSUFFICIENT_BALANCE");
      const meta = e.details as Record<string, unknown>;
      expect(meta.token).toBe("MNT");
      expect(meta.owner).toBe(OWNER);
      // required = amount + gas buffer (50k gas @ 20 Gwei = 0.001 MNT)
      expect(meta.required).toBe("10.001");
      expect(meta.current_balance).toBe("0");
    }
  });
});

describe("buildUnwrapMnt INSUFFICIENT_BALANCE throw path", () => {
  it("throws INSUFFICIENT_BALANCE when sender WMNT balance < amount", async () => {
    try {
      await buildUnwrapMnt(
        { amount: "5", sender: OWNER, network: "mainnet" },
        {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getClient: () => ({ readContract: async () => 0n }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
      throw new Error("expected buildUnwrapMnt to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MantleMcpError);
      const e = err as MantleMcpError;
      expect(e.code).toBe("INSUFFICIENT_BALANCE");
      const meta = e.details as Record<string, unknown>;
      expect(meta.token).toBe("WMNT");
      expect(meta.owner).toBe(OWNER);
      expect(meta.required).toBe("5");
      expect(meta.current_balance).toBe("0");
    }
  });
});

describe("buildAddLiquidity INSUFFICIENT_BALANCE throw path", () => {
  it("throws INSUFFICIENT_BALANCE for tokenA when allowance is sufficient but balance is zero", async () => {
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
              if (functionName === "getTokenX") return USDC_MAINNET.address;
              if (functionName === "allowance") return 10n ** 36n;           // always sufficient
              // balanceOf: USDC = 0 (insufficient), WMNT = plenty
              if (functionName === "balanceOf" && address.toLowerCase() === USDC_MAINNET.address.toLowerCase()) return 0n;
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
      expect(e.code).toBe("INSUFFICIENT_BALANCE");
      const meta = e.details as Record<string, unknown>;
      expect(meta.token).toBe("USDC");
      expect(meta.required).toBe("1000");
      expect(meta.current_balance).toBe("0");
    }
  });

  it("throws INSUFFICIENT_BALANCE for tokenB (WMNT) when tokenA balance is sufficient but tokenB is zero", async () => {
    // Regression for F-5: the Promise.allSettled loop iterates by index — a bug
    // that only checked index 0 (tokenA) would pass the tokenA test but miss tokenB.
    const FAKE_LB_PAIR_B = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
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
                return { binStep: 25, LBPair: FAKE_LB_PAIR_B, createdByOwner: false, ignoredForRouting: false };
              }
              if (functionName === "getActiveId") return 8388608;
              if (functionName === "getTokenX") return USDC_MAINNET.address;
              if (functionName === "allowance") return 10n ** 36n;            // always sufficient
              // balanceOf: USDC = plenty, WMNT = 0 (insufficient)
              if (functionName === "balanceOf" && address.toLowerCase() === WMNT_MAINNET.address.toLowerCase()) return 0n;
              return 1_000_000_000_000_000_000_000_000n; // USDC plenty
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
      throw new Error("expected buildAddLiquidity to throw for tokenB");
    } catch (err) {
      expect(err).toBeInstanceOf(MantleMcpError);
      const e = err as MantleMcpError;
      expect(e.code).toBe("INSUFFICIENT_BALANCE");
      const meta = e.details as Record<string, unknown>;
      expect(meta.token).toBe("WMNT");
      expect(meta.required).toBe("1");
      expect(meta.current_balance).toBe("0");
    }
  });
});
// USDC reserve: underlying=0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9,
//               aToken=0xcb8164415274515867ec43CbD284ab5d6d2b304F, decimals=6

describe("buildAaveSupply INSUFFICIENT_BALANCE throw path", () => {
  it("throws INSUFFICIENT_BALANCE when on_behalf_of balance < amount", async () => {
    try {
      await buildAaveSupply(
        { asset: "USDC", amount: "100", on_behalf_of: OWNER, network: "mainnet" },
        {
          resolveTokenInput: async () => USDC_MAINNET,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getClient: () => ({ readContract: async () => 0n }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
      throw new Error("expected buildAaveSupply to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MantleMcpError);
      const e = err as MantleMcpError;
      expect(e.code).toBe("INSUFFICIENT_BALANCE");
      const meta = e.details as Record<string, unknown>;
      expect(meta.token).toBe("USDC");
      expect(meta.required).toBe("100");
      expect(meta.current_balance).toBe("0");
    }
  });
});

describe("buildAaveRepay INSUFFICIENT_BALANCE throw path", () => {
  it("throws INSUFFICIENT_BALANCE when on_behalf_of balance < amount (non-max)", async () => {
    try {
      await buildAaveRepay(
        { asset: "USDC", amount: "50", on_behalf_of: OWNER, network: "mainnet" },
        {
          resolveTokenInput: async () => USDC_MAINNET,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getClient: () => ({ readContract: async () => 0n }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
      throw new Error("expected buildAaveRepay to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MantleMcpError);
      const e = err as MantleMcpError;
      expect(e.code).toBe("INSUFFICIENT_BALANCE");
      const meta = e.details as Record<string, unknown>;
      expect(meta.token).toBe("USDC");
      expect(meta.required).toBe("50");
      expect(meta.current_balance).toBe("0");
    }
  });

  it("skips balance check when amount='max' (repays full debt regardless of balance)", async () => {
    let sawBalanceError = false;
    try {
      await buildAaveRepay(
        { asset: "USDC", amount: "max", on_behalf_of: OWNER, network: "mainnet" },
        {
          resolveTokenInput: async () => USDC_MAINNET,
          // readContract always returns 0n — but balance check must be skipped for max
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getClient: () => ({ readContract: async () => 0n }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
    } catch (err) {
      if (err instanceof MantleMcpError && err.code === "INSUFFICIENT_BALANCE") {
        sawBalanceError = true;
      }
    }
    expect(sawBalanceError).toBe(false);
  });
});

describe("buildAaveWithdraw INSUFFICIENT_BALANCE throw path", () => {
  it("throws INSUFFICIENT_BALANCE when owner aToken balance < amount", async () => {
    // aToken for USDC on Mantle: 0xcb8164415274515867ec43CbD284ab5d6d2b304F
    const AUSDC = "0xcb8164415274515867ec43CbD284ab5d6d2b304F";
    try {
      await buildAaveWithdraw(
        // owner = signer; to = destination of underlying (same address here)
        { asset: "USDC", amount: "100", to: OWNER, owner: OWNER, network: "mainnet" },
        {
          resolveTokenInput: async () => USDC_MAINNET,
          getClient: () => ({
            readContract: async ({ address }: { address: string }) => {
              // aToken balanceOf = 0 → INSUFFICIENT_BALANCE
              if (address.toLowerCase() === AUSDC.toLowerCase()) return 0n;
              return 1_000_000_000n;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
      throw new Error("expected buildAaveWithdraw to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MantleMcpError);
      const e = err as MantleMcpError;
      expect(e.code).toBe("INSUFFICIENT_BALANCE");
      const meta = e.details as Record<string, unknown>;
      expect(meta.token).toBe("aUSDC");
      expect(meta.required).toBe("100");
      expect(meta.current_balance).toBe("0");
    }
  });

  it("does NOT throw when to≠signer and to has 0 aTokens but owner (signer) has sufficient", async () => {
    // Regression test for MI-1: Aave withdraw(asset, amount, to) burns the CALLER's
    // aTokens, not `to`'s. Checking `to`'s balance was wrong — we now check `owner`.
    const COLD_WALLET = "0x3333333333333333333333333333333333333333";
    const AUSDC = "0xcb8164415274515867ec43CbD284ab5d6d2b304F";
    let sawBalanceError = false;
    try {
      await buildAaveWithdraw(
        // to = cold wallet (0 aUSDC), owner = hot wallet (signer, has plenty of aUSDC)
        { asset: "USDC", amount: "100", to: COLD_WALLET, owner: OWNER, network: "mainnet" },
        {
          resolveTokenInput: async () => USDC_MAINNET,
          getClient: () => ({
            readContract: async ({ address, args }: { address: string; args: [`0x${string}`, ...unknown[]] }) => {
              // COLD_WALLET has 0 aTokens, OWNER has 1,000,000 (1 USDC = 1e6)
              if (address.toLowerCase() === AUSDC.toLowerCase()) {
                const balanceOfOwner = (args[0] as string).toLowerCase() === OWNER.toLowerCase()
                  ? 1_000_000_000_000n  // 1,000,000 USDC (plenty)
                  : 0n;                 // cold wallet has none
                return balanceOfOwner;
              }
              return 1_000_000_000_000n;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
    } catch (err) {
      if (err instanceof MantleMcpError && err.code === "INSUFFICIENT_BALANCE") {
        sawBalanceError = true;
      }
    }
    // The owner (signer) has plenty of aUSDC — should NOT block the withdraw
    expect(sawBalanceError).toBe(false);
  });

  it("skips balance check when owner is omitted (no false INSUFFICIENT_BALANCE for unknown signer)", async () => {
    let sawBalanceError = false;
    try {
      await buildAaveWithdraw(
        // owner omitted — balance check is skipped entirely
        { asset: "USDC", amount: "100", to: OWNER, network: "mainnet" },
        {
          resolveTokenInput: async () => USDC_MAINNET,
          // readContract always returns 0n — check must be skipped when owner is absent
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getClient: () => ({ readContract: async () => 0n }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
    } catch (err) {
      if (err instanceof MantleMcpError && err.code === "INSUFFICIENT_BALANCE") {
        sawBalanceError = true;
      }
    }
    expect(sawBalanceError).toBe(false);
  });

  it("skips balance check when amount='max' (withdraws full aToken balance)", async () => {
    let sawBalanceError = false;
    try {
      await buildAaveWithdraw(
        { asset: "USDC", amount: "max", to: OWNER, owner: OWNER, network: "mainnet" },
        {
          resolveTokenInput: async () => USDC_MAINNET,
          // readContract always returns 0n — but balance check must be skipped for max
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getClient: () => ({ readContract: async () => 0n }) as any,
          now: () => "2026-04-16T00:00:00.000Z",
          deadline: () => 1_800_000_000n
        }
      );
    } catch (err) {
      if (err instanceof MantleMcpError && err.code === "INSUFFICIENT_BALANCE") {
        sawBalanceError = true;
      }
    }
    expect(sawBalanceError).toBe(false);
  });
});
