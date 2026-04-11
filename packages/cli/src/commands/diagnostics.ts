import type { Command } from "commander";
import { allTools } from "@0xwh1sker/mantle-core/tools/index.js";
import { formatKeyValue, formatJson } from "../formatter.js";
import { parseJsonArray } from "../utils.js";

export function registerDiagnostics(parent: Command): void {
  const group = parent.command("diagnostics").description("RPC health and probing");

  group
    .command("rpc-health")
    .description("Check RPC endpoint health and chain-id consistency")
    .option("--rpc-url <url>", "RPC URL to test (defaults to configured endpoint)")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_checkRpcHealth"].handler({
        rpc_url: opts.rpcUrl ?? globals.rpcUrl,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        formatKeyValue(data, {
          order: [
            "endpoint", "reachable", "chain_id", "chain_id_matches",
            "block_number", "latency_ms", "error", "checked_at_utc"
          ],
          labels: {
            endpoint: "Endpoint",
            reachable: "Reachable",
            chain_id: "Chain ID",
            chain_id_matches: "Chain ID Matches",
            block_number: "Block",
            latency_ms: "Latency (ms)",
            error: "Error",
            checked_at_utc: "Checked At"
          }
        });
      }
    });

  group
    .command("probe")
    .description("Probe a JSON-RPC endpoint with a minimal method call")
    .option("--rpc-url <url>", "RPC endpoint to probe")
    .option("--method <method>", "RPC method (eth_chainId, eth_blockNumber, eth_getBalance)", "eth_blockNumber")
    .option("--params <json>", "optional method params as JSON array")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const params = opts.params
        ? parseJsonArray(opts.params as string, "params")
        : undefined;
      const result = await allTools["mantle_probeEndpoint"].handler({
        rpc_url: opts.rpcUrl ?? globals.rpcUrl,
        method: opts.method,
        params,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        formatKeyValue(data, {
          order: ["endpoint", "method", "success", "result", "error", "latency_ms", "probed_at_utc"],
          labels: {
            endpoint: "Endpoint",
            method: "Method",
            success: "Success",
            result: "Result",
            error: "Error",
            latency_ms: "Latency (ms)",
            probed_at_utc: "Probed At"
          }
        });
      }
    });
}
