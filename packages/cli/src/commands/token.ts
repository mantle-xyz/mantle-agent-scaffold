import type { Command } from "commander";
import { allTools } from "@0xwh1sker/mantle-core/tools/index.js";
import { formatKeyValue, formatTable, formatJson } from "../formatter.js";
import { parseCommaList } from "../utils.js";

export function registerToken(parent: Command): void {
  const group = parent.command("token").description("Token metadata and resolution");

  group
    .command("info")
    .description("Read ERC-20 token metadata (name, symbol, decimals, total supply)")
    .argument("<token>", "token symbol or address")
    .action(async (token: string, _opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_getTokenInfo"].handler({
        token,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        formatKeyValue(data, {
          order: ["name", "symbol", "address", "decimals", "total_supply_normalized", "network", "collected_at_utc"],
          labels: {
            name: "Name",
            symbol: "Symbol",
            address: "Address",
            decimals: "Decimals",
            total_supply_normalized: "Total Supply",
            network: "Network",
            collected_at_utc: "Collected At"
          }
        });
      }
    });

  group
    .command("prices")
    .description("Read token prices for valuation (null when no trusted source)")
    .requiredOption("--tokens <tokens>", "comma-separated token symbols or addresses")
    .option("--base-currency <currency>", "quote currency (usd, mnt)", "usd")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const tokens = parseCommaList(opts.tokens as string);
      const result = await allTools["mantle_getTokenPrices"].handler({
        tokens,
        base_currency: opts.baseCurrency,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        const prices = (data.prices ?? []) as Record<string, unknown>[];
        formatTable(prices, [
          { key: "symbol", label: "Token" },
          {
            key: "price",
            label: `Price (${(data.base_currency as string).toUpperCase()})`,
            align: "right",
            format: (v) => (v === null ? "N/A" : String(v))
          },
          { key: "source", label: "Source" },
          { key: "confidence", label: "Confidence" }
        ]);
      }
    });

  group
    .command("resolve")
    .description("Resolve token symbol via quick-ref + canonical token-list check")
    .argument("<symbol>", "token symbol to resolve")
    .option("--no-token-list-check", "skip canonical token-list match requirement")
    .action(async (symbol: string, opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_resolveToken"].handler({
        symbol,
        network: globals.network,
        require_token_list_match: opts.tokenListCheck !== false
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        formatKeyValue(data, {
          order: ["symbol", "address", "decimals", "source", "confidence", "token_list_match", "network"],
          labels: {
            symbol: "Symbol",
            address: "Address",
            decimals: "Decimals",
            source: "Source",
            confidence: "Confidence",
            token_list_match: "Token List Match",
            token_list_version: "Token List Version",
            network: "Network"
          }
        });
      }
    });
}
