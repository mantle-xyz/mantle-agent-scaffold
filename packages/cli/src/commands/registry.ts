import type { Command } from "commander";
import { allTools } from "@0xwh1sker/mantle-core/tools/index.js";
import { formatKeyValue, formatJson } from "../formatter.js";

export function registerRegistry(parent: Command): void {
  const group = parent.command("registry").description("Address resolution and validation");

  group
    .command("resolve")
    .description("Resolve trusted contract address by key, alias, or label")
    .argument("<identifier>", "registry key, alias, or label")
    .option("--category <category>", "filter category (system, token, bridge, defi, any)", "any")
    .action(async (identifier: string, opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_resolveAddress"].handler({
        identifier,
        network: globals.network,
        category: opts.category
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        formatKeyValue(data, {
          order: [
            "identifier", "network", "address", "label", "category",
            "status", "confidence", "aliases", "source_url"
          ],
          labels: {
            identifier: "Identifier",
            network: "Network",
            address: "Address",
            label: "Label",
            category: "Category",
            status: "Status",
            is_official: "Official",
            confidence: "Confidence",
            aliases: "Aliases",
            source_url: "Source URL"
          }
        });
      }
    });

  group
    .command("validate")
    .description("Validate address format, checksum, and optional bytecode presence")
    .argument("<address>", "address to validate")
    .option("--check-code", "check if deployed bytecode exists", false)
    .action(async (address: string, opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_validateAddress"].handler({
        address,
        check_code: opts.checkCode,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        formatKeyValue(data, {
          order: [
            "address", "valid_format", "is_checksummed",
            "is_zero_address", "has_code", "registry_match"
          ],
          labels: {
            address: "Address",
            valid_format: "Valid Format",
            is_checksummed: "Checksummed",
            is_zero_address: "Zero Address",
            has_code: "Has Code",
            registry_match: "Registry Match"
          }
        });
      }
    });
}
