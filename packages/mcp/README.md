# @0xwh1sker/mantle-mcp

MCP server for AI-driven Mantle L2 development — chain reads, simulation, and unsigned transaction building.

## Install

```bash
npm install @0xwh1sker/mantle-mcp
```

## Usage

Run the MCP server over stdio:

```bash
npx @0xwh1sker/mantle-mcp
```

Or add to your Claude Desktop / MCP client configuration:

```json
{
  "mcpServers": {
    "mantle": {
      "command": "npx",
      "args": ["@0xwh1sker/mantle-mcp"]
    }
  }
}
```

## Related packages

- [`@0xwh1sker/mantle-core`](https://www.npmjs.com/package/@0xwh1sker/mantle-core) — shared Mantle L2 business logic
- [`@0xwh1sker/mantle-cli`](https://www.npmjs.com/package/@0xwh1sker/mantle-cli) — CLI for Mantle chain reads, DeFi queries, and transaction building

## License

MIT
