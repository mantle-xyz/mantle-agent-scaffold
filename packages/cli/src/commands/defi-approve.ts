import type { Command } from "commander";
import { allTools } from "@mantleio/mantle-core/tools/index.js";
import { formatKeyValue, formatJson } from "../formatter.js";

/**
 * Top-level ERC-20 approve command:
 *   approve — Build unsigned ERC-20 approve for whitelisted spender
 *
 * Hoisted out of `swap` because approvals are not swap-specific — they are
 * required by swaps, LP, Aave, and any other DeFi interaction.
 */
export function registerApprove(parent: Command): void {
  parent
    .command("approve")
    .description("Build an unsigned ERC-20 approve for a whitelisted spender")
    .requiredOption("--token <token>", "token symbol or address")
    .requiredOption("--spender <address>", "whitelisted contract address to approve")
    .requiredOption("--amount <amount>", "decimal amount to approve, or 'max' for unlimited")
    .option("--owner <address>", "wallet address (used to check existing allowance)")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_buildApprove"].handler({
        token: opts.token,
        spender: opts.spender,
        amount: String(opts.amount),
        owner: opts.owner,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatUnsignedTxResult(result as Record<string, unknown>);
      }
    });
}

// ---------------------------------------------------------------------------
// Local formatter for unsigned-tx results (mirrors defi-swap.ts)
// ---------------------------------------------------------------------------

function formatUnsignedTxResult(data: Record<string, unknown>): void {
  const tx = data.unsigned_tx as Record<string, unknown> | undefined;
  const warnings = (data.warnings ?? []) as string[];

  const fields: Record<string, unknown> = {
    intent: data.intent,
    human_summary: data.human_summary,
    tx_to: tx?.to,
    tx_value: tx?.value,
    tx_chainId: tx?.chainId,
    tx_data: truncateHex(tx?.data as string | undefined),
    tx_gas: tx?.gas ?? "auto",
    built_at: data.built_at_utc
  };

  const labels: Record<string, string> = {
    intent: "Intent",
    human_summary: "Summary",
    tx_to: "To",
    tx_value: "Value (hex)",
    tx_chainId: "Chain ID",
    tx_data: "Calldata",
    tx_gas: "Gas Limit",
    built_at: "Built At"
  };

  formatKeyValue(fields, { labels });

  if (warnings.length > 0) {
    console.log("  Warnings:");
    for (const w of warnings) {
      console.log(`    - ${w}`);
    }
    console.log();
  }
}

function truncateHex(hex: string | undefined): string {
  if (!hex) return "null";
  if (hex.length <= 66) return hex;
  return `${hex.slice(0, 34)}...${hex.slice(-16)} (${hex.length} chars)`;
}
