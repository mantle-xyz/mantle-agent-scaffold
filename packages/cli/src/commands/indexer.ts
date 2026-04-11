import type { Command } from "commander";
import { allTools } from "@0xwh1sker/mantle-core/tools/index.js";
import { formatTable, formatJson, formatKeyValue } from "../formatter.js";
import { parseIntegerOption, parseJsonString } from "../utils.js";

export function registerIndexer(parent: Command): void {
  const group = parent.command("indexer").description("Subgraph and SQL queries");

  group
    .command("subgraph")
    .description("Run GraphQL query against a Mantle indexer")
    .requiredOption("--endpoint <url>", "GraphQL endpoint URL")
    .requiredOption("--query <graphql>", "GraphQL query document")
    .option("--variables <json>", "optional GraphQL variables as JSON string")
    .option("--timeout <ms>", "request timeout in milliseconds", (value: string) =>
      parseIntegerOption(value, "--timeout")
    )
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const variables = opts.variables
        ? parseJsonString(opts.variables as string, "variables")
        : undefined;
      const result = await allTools["mantle_querySubgraph"].handler({
        endpoint: opts.endpoint,
        query: opts.query,
        variables,
        timeout_ms: opts.timeout,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        formatKeyValue(
          {
            endpoint: data.endpoint,
            queried_at: data.queried_at_utc,
            elapsed_ms: data.elapsed_ms
          },
          {
            labels: {
              endpoint: "Endpoint",
              queried_at: "Queried At",
              elapsed_ms: "Elapsed (ms)"
            }
          }
        );
        if (data.errors) {
          console.log("  Errors:", JSON.stringify(data.errors, null, 2));
        }
        if (data.data) {
          console.log(JSON.stringify(data.data, null, 2));
        }
      }
    });

  group
    .command("sql")
    .description("Run read-only SQL query against an indexer")
    .requiredOption("--endpoint <url>", "SQL indexer endpoint URL")
    .requiredOption("--query <sql>", "read-only SQL query")
    .option("--params <json>", "optional query params as JSON string")
    .option("--timeout <ms>", "request timeout in milliseconds", (value: string) =>
      parseIntegerOption(value, "--timeout")
    )
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const params = opts.params
        ? parseJsonString(opts.params as string, "params")
        : undefined;
      const result = await allTools["mantle_queryIndexerSql"].handler({
        endpoint: opts.endpoint,
        query: opts.query,
        params,
        timeout_ms: opts.timeout,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        const columns = (data.columns ?? []) as string[];
        const rows = (data.rows ?? []) as unknown[][];
        console.log(`\n  Endpoint: ${data.endpoint}  Rows: ${data.row_count}  Elapsed: ${data.elapsed_ms}ms\n`);
        if (rows.length > 0 && columns.length > 0) {
          const tableRows = rows.map((row) => {
            const record: Record<string, unknown> = {};
            columns.forEach((col, i) => {
              record[col] = Array.isArray(row) ? row[i] : (row as Record<string, unknown>)[col];
            });
            return record;
          });
          formatTable(
            tableRows,
            columns.map((col) => ({ key: col, label: col }))
          );
        }
        if (data.truncated) {
          console.log("  (Results truncated)");
        }
      }
    });
}
