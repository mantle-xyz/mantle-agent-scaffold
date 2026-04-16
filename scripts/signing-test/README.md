# Mantle CLI Signing Test Suite

End-to-end tests that exercise the full lifecycle: **CLI builds unsigned_tx** → **private key signs** → **broadcast to Sepolia** → **verify on-chain**.

## Quick Start

```bash
# 1. Build the monorepo (from project root)
cd ../..
npm run build

# 2. Install test dependencies
cd scripts/signing-test
npm install

# 3. Run in dry-run mode (no broadcast, no wallet needed)
TEST_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 npm run test:dry

# 4. Run live on Sepolia (requires funded wallet)
TEST_PRIVATE_KEY=0xYOUR_FUNDED_SEPOLIA_KEY npm test
```

## Prerequisites

| Requirement | Details |
|-------------|---------|
| Node.js | >= 20 |
| Monorepo built | `npm run build` at project root |
| Private key | Exported from any wallet, with `0x` prefix |
| Sepolia MNT | Fund via [faucet.sepolia.mantle.xyz](https://faucet.sepolia.mantle.xyz/) |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TEST_PRIVATE_KEY` | Yes | Private key with `0x` prefix |
| `DRY_RUN` | No | Set to `true` to skip broadcasting |
| `MANTLE_SEPOLIA_RPC_URL` | No | Custom Sepolia RPC (defaults to public) |

## What It Tests

### Read Operations (no signing)
- `chain info` — returns correct Sepolia chain data
- `chain status` — returns current block number
- `account balance` — matches direct RPC balance
- `token info` — resolves WMNT on Sepolia
- `registry resolve` — resolves WMNT address
- `diagnostics rpc-health` — RPC endpoint health check
- `utils parse-units` / `format-units` — decimal ↔ raw conversion

### Write Operations (sign & broadcast)
- **Transfer native MNT** — self-transfer, verify gas cost only
- **Wrap MNT → WMNT** — verify WMNT ERC-20 balance increase
- **Unwrap WMNT → MNT** — verify MNT balance recovery
- **Raw tx via build-tx** — manual calldata construction

### Verification
- **TX receipt via CLI** — cross-verify broadcast tx using `chain tx --hash`

### Error Cases
- Zero address rejection
- Invalid address format rejection
- Negative amount rejection

## Architecture

```
scripts/signing-test/
├── src/
│   ├── run-tests.ts    ← Main entry point, all test cases
│   ├── wallet.ts       ← viem WalletClient + signing helpers
│   ├── cli.ts          ← Spawns mantle-cli as child process
│   ├── runner.ts       ← Test harness with structured reporting
│   └── assert.ts       ← Lightweight assertion helpers
├── package.json
├── tsconfig.json
└── README.md
```

### Design Decisions

1. **Spawns the CLI binary** (`node packages/cli/dist/index.js`) rather than importing core directly — this tests the full CLI surface including argument parsing, `--json` output, and error handling.

2. **Sepolia only** — the signing module hard-rejects `chainId !== 5003` to prevent accidental mainnet transactions.

3. **Self-transfers** — native MNT transfer sends to the sender's own address, so only gas is consumed. This minimizes testnet token usage.

4. **Wrap/Unwrap cycle** — wraps a small amount then immediately unwraps, verifying ERC-20 balance changes. Net cost is only gas.

## Extending

To add a new test case:

```typescript
import { test, setTxHash, setDetails } from "./runner.js";
import { buildTx } from "./cli.js";
import { signAndSend } from "./wallet.js";

test("my new test", async () => {
  // 1. Build the unsigned tx via CLI
  const tx = await buildTx(["swap", "wrap-mnt", "--amount", "0.001"]);

  // 2. Sign and broadcast
  const result = await signAndSend(wallet, tx.unsigned_tx, { dryRun: DRY_RUN });

  // 3. Verify
  if (result) {
    assertEqual(result.receipt.status, "success", "tx status");
    setTxHash(result.hash);
  }
});
```
