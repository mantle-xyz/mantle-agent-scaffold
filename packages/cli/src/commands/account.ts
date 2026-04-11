import type { Command } from "commander";
import { allTools } from "@0xwh1sker/mantle-core/tools/index.js";
import { formatKeyValue, formatTable, formatJson } from "../formatter.js";
import { parseCommaList } from "../utils.js";

export function registerAccount(parent: Command): void {
  const group = parent.command("account").description("Wallet and account queries");

  group
    .command("balance")
    .description("Get native MNT balance for an address")
    .argument("<address>", "wallet address")
    .action(async (address: string, _opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_getBalance"].handler({
        address,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        formatKeyValue(data, {
          order: ["address", "network", "balance_mnt", "block_number", "collected_at_utc"],
          labels: {
            address: "Address",
            network: "Network",
            balance_mnt: "Balance (MNT)",
            block_number: "Block",
            collected_at_utc: "Collected At"
          }
        });
      }
    });

  group
    .command("token-balances")
    .description("Batch read ERC-20 token balances")
    .argument("<address>", "wallet address")
    .requiredOption("--tokens <tokens>", "comma-separated token symbols or addresses")
    .action(async (address: string, opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const tokens = parseCommaList(opts.tokens as string);
      const result = await allTools["mantle_getTokenBalances"].handler({
        address,
        tokens,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        const balances = (data.balances ?? []) as Record<string, unknown>[];
        console.log(`\n  Address: ${data.address}  Network: ${data.network}  Block: ${data.block_number}\n`);
        formatTable(balances, [
          { key: "symbol", label: "Token" },
          { key: "balance_normalized", label: "Balance", align: "right" },
          { key: "token_address", label: "Address" },
          { key: "error", label: "Error" }
        ]);
      }
    });

  group
    .command("allowances")
    .description("Batch read ERC-20 allowances for token/spender pairs")
    .argument("<owner>", "owner address")
    .requiredOption("--pairs <pairs>", "comma-separated token:spender pairs")
    .action(async (owner: string, opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const pairsRaw = parseCommaList(opts.pairs as string);
      const pairs = pairsRaw.map((pair) => {
        const [token, spender] = pair.split(":");
        return { token, spender };
      });
      const result = await allTools["mantle_getAllowances"].handler({
        owner,
        pairs,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        const allowances = (data.allowances ?? []) as Record<string, unknown>[];
        console.log(`\n  Owner: ${data.owner}  Network: ${data.network}  Block: ${data.block_number}\n`);
        formatTable(allowances, [
          { key: "token_symbol", label: "Token" },
          { key: "spender", label: "Spender" },
          { key: "spender_label", label: "Spender Label" },
          { key: "allowance_normalized", label: "Allowance", align: "right" },
          { key: "is_unlimited", label: "Unlimited" },
          { key: "error", label: "Error" }
        ]);
      }
    });
}
