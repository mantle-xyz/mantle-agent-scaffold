# Mantle CLI Signing Test Suite

End-to-end black-box tests for the `mantle-cli` write surface. Each scenario
shells out to the built CLI, parses the returned `unsigned_tx`, signs it with
a funded wallet, broadcasts on **Mantle mainnet** (chainId `5000`), and then
verifies on-chain state via the same CLI.

> **⚠ These tests run on mainnet with real MNT.** Use a dedicated test wallet
> and keep amounts small (the defaults total well under $1 per full run).
> A `DRY_RUN=true` mode is provided that only builds and prints calldata — no
> signing, no broadcast — and is the right way to smoke-test CLI changes.

## Layout

```
scripts/signing-test/
├── src/
│   ├── scenario-swap.ts      ← wrap/unwrap, Agni V3 swap, Moe LB swap
│   ├── scenario-moe-swap.ts  ← Moe multi-version roundtrip (V2.2 direct / V2.2 auto / V1 AMM)
│   ├── scenario-lp.ts        ← Agni V3 add/collect/remove + Moe LB add/remove
│   ├── scenario-aave.ts      ← supply / borrow / repay / withdraw on Aave
│   ├── runner.ts          ← test harness (PASS/FAIL + tx-hash reporting)
│   ├── cli.ts             ← spawns mantle-cli as a child process, parses JSON
│   ├── wallet.ts          ← viem WalletClient + signAndSend (with dry-run)
│   ├── helpers.ts         ← approve/balance/decimals utilities
│   ├── assert.ts          ← lightweight assertions
│   ├── constants.ts       ← token + pool registry (mainnet, on-chain verified)
│   ├── debug-*.{ts,mjs}   ← one-off diagnostic scripts (see below)
│   └── setup-links.mjs    ← creates @mantleio/* symlinks in repo node_modules
├── package.json
├── tsconfig.json
└── .env                   ← gitignored — your TEST_PRIVATE_KEY lives here
```

## Prerequisites

| Requirement      | Details                                                       |
|------------------|---------------------------------------------------------------|
| Node.js          | >= 20                                                         |
| Built monorepo   | `npm run build` at the repo root (produces `packages/*/dist`) |
| Funded wallet    | A few MNT for gas; USDC/USDT/USDe/USDT0 for the LP+Aave runs  |
| `TEST_PRIVATE_KEY` | Hex string with `0x` prefix; passed via env or `.env` file  |

The runner reads `TEST_PRIVATE_KEY` from `process.env`; if you start the
script with `node --env-file-if-exists=.env …` (which `npm run test:*` does)
it will be picked up from a local `.env` automatically.

## Setup

From the repo root:

```bash
# 1. Build the CLI / core packages once
npm install
npm run build

# 2. Install the test-suite's own deps
cd scripts/signing-test
npm install

# 3. Create your local .env (gitignored)
printf 'TEST_PRIVATE_KEY=0xYOUR_KEY_HERE\n' > .env
```

The package scripts use `node --env-file-if-exists=.env`, so the `.env` is
loaded only when present and never committed — `scripts/signing-test/.env`
is in this directory's `.gitignore` (line 3).

## Running scenarios

Each scenario has a `:dry` variant that builds calldata without broadcasting.
Always start there to validate CLI output before spending gas:

```bash
# Dry runs — no signing, no broadcast, no MNT needed
npm run test:swap:dry
npm run test:moe-swap:dry
npm run test:lp:dry
npm run test:aave:dry

# Live runs — signs and broadcasts on Mantle mainnet
npm run test:swap
npm run test:moe-swap
npm run test:lp
npm run test:aave
```

You can also pass `TEST_PRIVATE_KEY` inline if you don't want a `.env`:

```bash
TEST_PRIVATE_KEY=0x… npm run test:lp
DRY_RUN=true TEST_PRIVATE_KEY=0x… npm run test:lp:dry  # equivalent to test:lp:dry
```

### Wallet funding cheat-sheet

| Scenario  | Needed in wallet                                          | Approx total gas |
|-----------|-----------------------------------------------------------|------------------|
| swap      | ~1 MNT                                                    | ≤ $0.05          |
| moe-swap  | ~0.2 MNT (three small roundtrips on Moe)                  | ≤ $0.05          |
| lp        | ~1 MNT + ~$0.05 USDe (or whatever the scenario LPs)       | ≤ $0.20          |
| aave      | ~1 MNT + a few cents of a supply asset (USDC by default)  | ≤ $0.10          |

The exact amounts are constants at the top of each scenario (`WRAP_AMOUNT`,
`AGNI_LP_*`, `MOE_LP_*`, etc.) — tweak them if MNT price moves materially.

## Reading the output

Each scenario prints a chalk-formatted summary:

```
=== Mantle Signing Test Suite ===
Tests:   8

[1/8] RUN   Wrap MNT → WMNT ... PASS (2.3s) tx: 0xabc12345...
[2/8] RUN   Swap WMNT → USDC ... PASS (3.1s) tx: 0xdef67890...
[3/8] RUN   Agni: add liquidity ... FAIL (4.0s)
      Price slippage check (0x739dbe52)
…

=== Results ===
  Passed:  6  Failed: 2
  Total time: 24.7s

Failed tests:
  - Agni: add liquidity
    Price slippage check (0x739dbe52)

Transactions:
  https://mantlescan.xyz/tx/0xabc1…
  https://mantlescan.xyz/tx/0xdef6…
```

Process exits non-zero when any test fails, so the scripts are CI-friendly.

## Debug helpers

These are not part of the regression suite; use them when investigating an
issue or verifying constants:

```bash
npm run debug:cli         # smoke-test the CLI binary path & --json output
npm run debug:tools       # list all registered MCP tool names
npm run debug:pools       # dump on-chain state for the pools in constants.ts
npm run debug:positions   # enumerate V3 + LB positions for $TEST_PRIVATE_KEY
npm run setup:links       # (re)create @mantleio/* symlinks in workspace node_modules
```

`setup:links` is only needed if your local `node_modules/@mantleio/*` got
out of sync with the workspace packages — normal `npm install` from the
repo root handles this for you.

## Adding a new test

```typescript
import { test, setTxHash, setDetails } from "./runner.js";
import { buildTx } from "./cli.js";
import { signAndSend } from "./wallet.js";

test("my new write-path test", async () => {
  // 1. Ask the CLI to build the unsigned tx
  const tx = await buildTx(["swap", "wrap-mnt", "--amount", "0.001"]);

  // 2. Sign + broadcast (no-op when DRY_RUN=true)
  const result = await signAndSend(wallet, tx.unsigned_tx, { dryRun: DRY_RUN });

  // 3. Assert + record
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    setTxHash(result.hash);
    setDetails({ gas_used: result.receipt.gasUsed.toString() });
  }
});
```

Register the test inside an existing `scenario-*.ts` (its `main()` calls
`runAllTests()`) or create a new scenario file and add a matching script
in `package.json`.

## Design notes

1. **Black-box, not unit.** Tests spawn `node packages/cli/dist/index.js`
   rather than importing core directly. This exercises argument parsing,
   `--json` envelope, and exit codes — exactly what an LLM agent or shell
   user sees. If a scenario fails, the bug is in the CLI or core, not here.

2. **Mainnet only by design.** Many of the protocols under test (Agni,
   Merchant Moe, Aave Mantle pool) have no Sepolia deployment, and their
   mainnet whitelisting is what we want to validate. `wallet.ts` defines
   both chains, but the scenarios pin `NETWORK = "mainnet"` and the
   `signAndSend` helper rejects any `chainId !== wallet.chainId`.

3. **Ignore CLI gas suggestions.** `signAndSend` deliberately drops the
   `unsigned_tx.gas` hint and lets the node estimate. The hardcoded values
   in `defi-write.ts` are conservative for some flows and too low for others
   on Mantle.
