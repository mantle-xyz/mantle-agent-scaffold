# mantle-agent-scaffold

Mantle MCP server for AI agents. Provides read and write tools for DeFi operations on Mantle L2 — swap, LP, lending (Aave V3), token approvals, and more. All write tools return unsigned transaction payloads; they never hold private keys or broadcast.

Supported protocols: **Merchant Moe**, **Agni Finance**, **Fluxion**, **Aave V3**.

## Install as MCP Server

Add to your `.mcp.json` or Claude Code `settings.json`:

```json
{
  "mcpServers": {
    "mantle": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@0xwh1sker/mantle-mcp"]
    }
  }
}
```

Restart your agent after adding the config. `npx` will fetch the package from npm and start the MCP server over stdio.

## Available Tools

### Read Tools (query on-chain state)

| Tool | Purpose |
|------|---------|
| `mantle_getBalance` | Native MNT balance |
| `mantle_getTokenBalances` | ERC-20 balances for multiple tokens |
| `mantle_getAllowances` | Check token approvals for a spender |
| `mantle_getSwapQuote` | Get swap price quote from a DEX |
| `mantle_getPoolLiquidity` | Pool reserves and TVL |
| `mantle_getPoolOpportunities` | Discover LP opportunities for a token |
| `mantle_getLendingMarkets` | Aave V3 market data (APY, utilization) |
| `mantle_getProtocolTvl` | Protocol-level TVL |
| `mantle_resolveToken` | Resolve symbol → address + decimals |
| `mantle_resolveAddress` | Resolve protocol name → contract address |
| `mantle_validateAddress` | Verify an address is valid and active |
| `mantle_getChainInfo` | Chain ID, RPC, explorer URLs |
| `mantle_getChainStatus` | Block height, gas price |
| `mantle_getTokenPrices` | USD prices for tokens |
| `mantle_getTokenInfo` | Token metadata (name, symbol, decimals) |
| `mantle_querySubgraph` | Query subgraph endpoints |
| `mantle_queryIndexerSql` | Query SQL indexer |
| `mantle_checkRpcHealth` | RPC endpoint health check |
| `mantle_probeEndpoint` | Probe custom endpoint |

### Write Tools (build unsigned transactions)

Every write tool returns an `unsigned_tx` object with `{ to, data, value, chainId }`. The caller must sign and broadcast externally.

| Tool | Purpose | Supported Protocols |
|------|---------|-------------------|
| `mantle_buildApprove` | ERC-20 approve (whitelist-enforced) | Any whitelisted spender |
| `mantle_buildWrapMnt` | Wrap MNT → WMNT | WMNT |
| `mantle_buildUnwrapMnt` | Unwrap WMNT → MNT | WMNT |
| `mantle_buildSwap` | Swap tokens | Agni, Fluxion, Merchant Moe |
| `mantle_buildAddLiquidity` | Add LP position | Agni, Fluxion, Merchant Moe |
| `mantle_buildRemoveLiquidity` | Remove LP position | Agni, Fluxion, Merchant Moe |
| `mantle_buildAaveSupply` | Deposit into Aave V3 | Aave V3 |
| `mantle_buildAaveBorrow` | Borrow from Aave V3 | Aave V3 |
| `mantle_buildAaveRepay` | Repay Aave V3 debt | Aave V3 |
| `mantle_buildAaveWithdraw` | Withdraw from Aave V3 | Aave V3 |

## DeFi Workflow

The standard execution flow for any DeFi operation:

```
1. READ   — Check balances, get quotes, check allowances
2. BUILD  — Call mantle_build* to get unsigned_tx
3. SHOW   — Present human_summary to user for confirmation
4. SIGN   — Sign and broadcast the unsigned_tx externally
5. WAIT   — Wait for tx confirmation before next step
6. REPEAT — Continue with next operation in the sequence
```

### Example: Swap 10 MNT → USDC on Agni

```
Step 1: mantle_buildWrapMnt({ amount: "10" })
        → sign & broadcast → 10 WMNT

Step 2: mantle_getSwapQuote({ provider: "agni", token_in: "WMNT", token_out: "USDC", amount_in: "10" })
        → estimated: ~8.5 USDC

Step 3: mantle_buildApprove({ token: "WMNT", spender: "0x319B69888b0d11cEC22caA5034e25FfFBDc88421", amount: "10" })
        → sign & broadcast

Step 4: mantle_buildSwap({ provider: "agni", token_in: "WMNT", token_out: "USDC", amount_in: "10", recipient: "0xYOUR_WALLET", fee_tier: 3000 })
        → sign & broadcast → receive USDC
```

### Example: Add WMNT-USDe LP on Merchant Moe

```
Step 1: Wrap MNT → WMNT (mantle_buildWrapMnt)
Step 2: Swap half WMNT → USDe (mantle_buildSwap, provider: "merchant_moe")
Step 3: Approve WMNT for LB Router (mantle_buildApprove, spender: "0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a")
Step 4: Approve USDe for LB Router (mantle_buildApprove)
Step 5: Add liquidity (mantle_buildAddLiquidity, provider: "merchant_moe")
```

## Whitelisted Contracts

Write tools enforce a whitelist. Only these contracts can be used as `spender` in approve or as swap/LP targets:

| Protocol | Contract | Address |
|----------|----------|---------|
| Merchant Moe | MoeRouter | `0xeaEE7EE68874218c3558b40063c42B82D3E7232a` |
| Merchant Moe | LB Router V2.2 | `0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a` |
| Agni | SwapRouter | `0x319B69888b0d11cEC22caA5034e25FfFBDc88421` |
| Agni | PositionManager | `0x218bf598D1453383e2F4AA7b14fFB9BfB102D637` |
| Fluxion | SwapRouter | `0x5628a59df0ecac3f3171f877a94beb26ba6dfaa0` |
| Fluxion | PositionManager | `0x2b70c4e7ca8e920435a5db191e066e9e3afd8db3` |
| Aave V3 | Pool | `0x458F293454fE0d67EC0655f3672301301DD51422` |
| Aave V3 | WETHGateway | `0x9C6cCAC66b1c9AbA4855e2dD284b9e16e41E06eA` |
| WMNT | WMNT | `0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8` |

## Safety Rules

1. **Never hold private keys** — all `mantle_build*` tools return unsigned payloads only
2. **Verify addresses first** — use `mantle_resolveAddress` / `mantle_resolveToken` before building transactions
3. **Get a quote before swapping** — call `mantle_getSwapQuote` to know expected output
4. **Show `human_summary`** — every build tool returns a human-readable summary; present it to the user before signing
5. **MNT is the gas token** — not ETH; all gas estimates are in MNT
6. **Never fabricate calldata** — always use the build tools; do not construct transaction data manually

## Skills

Skills provide domain-specific workflows. The local `skills/` checkout is pinned to the external [mantle-xyz/mantle-skills](https://github.com/mantle-xyz/mantle-skills) repository. After installing the MCP server, initialize the skills submodule:

```bash
npm run skills:init
```

To refresh the pinned checkout:

```bash
npm run skills:sync
```

Skill definitions live under `skills/skills/<skill-name>/SKILL.md`. Relevant skills for DeFi:

| Skill | Purpose |
|-------|---------|
| `mantle-defi-operator` | DeFi venue discovery, comparison, execution planning |
| `mantle-risk-evaluator` | Risk scoring before state-changing operations |
| `mantle-tx-simulator` | Pre-signing simulation summaries |
| `mantle-portfolio-analyst` | Wallet balance/allowance analysis |
| `mantle-address-registry-navigator` | Canonical address resolution |

## Local Development

```bash
npm install
npm run skills:init
npm run build
npm start -w packages/mcp
```

Verify:

```bash
npm test
```

## CLI

```bash
npx @0xwh1sker/mantle-cli chain info
npx @0xwh1sker/mantle-cli registry resolve USDC --json
npx @0xwh1sker/mantle-cli token prices --tokens USDC,WETH --json
```

## Packages

This monorepo produces three independently publishable packages:

| Package | Description |
|---------|-------------|
| [`@0xwh1sker/mantle-core`](packages/core/README.md) | Shared business logic — tools, config, and chain interaction |
| [`@0xwh1sker/mantle-cli`](packages/cli/README.md) | CLI for chain reads, DeFi queries, and transaction building |
| [`@0xwh1sker/mantle-mcp`](packages/mcp/README.md) | MCP server for AI agents |

## Documentation

- [Docs site](https://mantle-xyz.github.io/mantle-agent-scaffold/)
- [External Agent Integration](https://mantle-xyz.github.io/mantle-agent-scaffold/concepts/external-agents/)
- [Skills and MCP Usage](https://mantle-xyz.github.io/mantle-agent-scaffold/concepts/skills/)
- [Architecture Model](https://mantle-xyz.github.io/mantle-agent-scaffold/concepts/architecture/)
