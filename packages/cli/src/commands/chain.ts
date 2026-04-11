import type { Command } from "commander";
import { allTools } from "@0xwh1sker/mantle-core/tools/index.js";
import { formatKeyValue, formatJson } from "../formatter.js";

export function registerChain(parent: Command): void {
  const group = parent.command("chain").description("Chain information");

  group
    .command("info")
    .description("Static chain configuration for mainnet or sepolia")
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_getChainInfo"].handler({
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        formatKeyValue(data, {
          order: [
            "chain_id", "name", "native_token", "rpc_url", "ws_url",
            "explorer_url", "bridge_url", "wrapped_mnt",
            "recommended_solidity_compiler", "faucet_urls"
          ],
          labels: {
            chain_id: "Chain ID",
            name: "Name",
            native_token: "Native Token",
            rpc_url: "RPC URL",
            ws_url: "WebSocket URL",
            explorer_url: "Explorer",
            bridge_url: "Bridge",
            wrapped_mnt: "WMNT Address",
            recommended_solidity_compiler: "Solidity Compiler",
            faucet_urls: "Faucet URLs"
          }
        });
      }
    });

  group
    .command("status")
    .description("Live block height and gas price from Mantle RPC")
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_getChainStatus"].handler({
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        formatKeyValue(data, {
          order: ["chain_id", "block_number", "gas_price_gwei", "syncing", "timestamp_utc"],
          labels: {
            chain_id: "Chain ID",
            block_number: "Block",
            gas_price_gwei: "Gas Price (Gwei)",
            syncing: "Syncing",
            timestamp_utc: "Timestamp"
          }
        });
      }
    });
}
