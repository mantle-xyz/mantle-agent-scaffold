# @0xwh1sker/mantle-core

Shared business logic for Mantle L2 tooling — chain reads, DeFi queries, and unsigned transaction building.

## Install

```bash
npm install @0xwh1sker/mantle-core
```

## What's included

- **tools/** — callable handlers for chain, registry, account, token, DeFi, indexer, and diagnostics operations
- **lib/** — shared helpers: viem clients, network normalization, token registry, endpoint policy, contract ABIs
- **config/** — chain configs, token lists, protocol metadata, DEX pairs, Aave reserves
- **errors.ts** — `MantleMcpError` error class
- **types.ts** — `Tool`, `Resource`, `Network` type definitions
- **capability-catalog.ts** — structured tool metadata for LLM discovery

## Usage

```ts
import { allTools } from "@0xwh1sker/mantle-core/tools/index.js";

const result = await allTools["mantle_getChainInfo"].handler({ network: "mainnet" });
console.log(result);
```

## Related packages

- [`@0xwh1sker/mantle-cli`](https://www.npmjs.com/package/@0xwh1sker/mantle-cli) — CLI interface built on mantle-core
- [`@0xwh1sker/mantle-mcp`](https://www.npmjs.com/package/@0xwh1sker/mantle-mcp) — MCP server for AI agents

## License

MIT
