import type { Command } from "commander";
import { allTools } from "@0xwh1sker/mantle-core/tools/index.js";
import { formatKeyValue, formatTable, formatJson } from "../formatter.js";
import { parseNumberOption, parseIntegerOption } from "../utils.js";

/**
 * DEX swap & token operations:
 *   swap build-swap   — Build unsigned swap transaction
 *   swap approve      — Build unsigned ERC-20 approve for whitelisted spender
 *   swap wrap-mnt     — Build unsigned wrap MNT → WMNT
 *   swap unwrap-mnt   — Build unsigned unwrap WMNT → MNT
 *   swap pairs        — List known trading pairs & pool parameters
 */
export function registerSwap(parent: Command): void {
  const group = parent
    .command("swap")
    .description("DEX swap & token operations (build unsigned transactions)");

  // ── build-swap ──────────────────────────────────────────────────────
  group
    .command("build-swap")
    .description("Build an unsigned swap transaction for Agni, Fluxion, or Merchant Moe")
    .requiredOption("--provider <provider>", "DEX provider: agni, fluxion, or merchant_moe")
    .requiredOption("--in <token>", "input token symbol or address")
    .requiredOption("--out <token>", "output token symbol or address")
    .requiredOption("--amount <amount>", "human-readable amount of input token")
    .requiredOption("--recipient <address>", "address to receive output tokens")
    .option("--amount-out-min <amount>", "minimum output (raw units from swap-quote). '0' if unknown (not recommended)")
    .option(
      "--slippage-bps <bps>",
      "slippage tolerance in basis points (default: 50 = 0.5%)",
      (v: string) => parseIntegerOption(v, "--slippage-bps")
    )
    .option(
      "--fee-tier <tier>",
      "V3 fee tier (500, 3000, 10000). Auto-resolved from known pairs",
      (v: string) => parseNumberOption(v, "--fee-tier")
    )
    .option(
      "--bin-step <step>",
      "LB bin step (1, 5, 20). Auto-resolved from known pairs",
      (v: string) => parseIntegerOption(v, "--bin-step")
    )
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_buildSwap"].handler({
        provider: opts.provider,
        token_in: opts.in,
        token_out: opts.out,
        amount_in: String(opts.amount),
        recipient: opts.recipient,
        amount_out_min: opts.amountOutMin ? String(opts.amountOutMin) : undefined,
        slippage_bps: opts.slippageBps,
        fee_tier: opts.feeTier,
        bin_step: opts.binStep,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatUnsignedTxResult(result as Record<string, unknown>);
      }
    });

  // ── approve ─────────────────────────────────────────────────────────
  group
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

  // ── wrap-mnt ────────────────────────────────────────────────────────
  group
    .command("wrap-mnt")
    .description("Build an unsigned wrap MNT → WMNT transaction")
    .requiredOption("--amount <amount>", "decimal amount of MNT to wrap")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_buildWrapMnt"].handler({
        amount: String(opts.amount),
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatUnsignedTxResult(result as Record<string, unknown>);
      }
    });

  // ── unwrap-mnt ──────────────────────────────────────────────────────
  group
    .command("unwrap-mnt")
    .description("Build an unsigned unwrap WMNT → MNT transaction")
    .requiredOption("--amount <amount>", "decimal amount of WMNT to unwrap")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_buildUnwrapMnt"].handler({
        amount: String(opts.amount),
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatUnsignedTxResult(result as Record<string, unknown>);
      }
    });

  // ── pairs ───────────────────────────────────────────────────────────
  group
    .command("pairs")
    .description("List known trading pairs and pool parameters per DEX")
    .option("--provider <provider>", "filter by DEX: agni, fluxion, or merchant_moe")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_getSwapPairs"].handler({
        provider: opts.provider,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        const pairColumns = [
          { key: "tokenA", label: "Token A" },
          { key: "tokenB", label: "Token B" },
          { key: "pool", label: "Pool Address" },
          {
            key: "fee_tier",
            label: "Fee Tier",
            align: "right" as const,
            format: (v: unknown) => (v === undefined ? "-" : String(v))
          },
          {
            key: "bin_step",
            label: "Bin Step",
            align: "right" as const,
            format: (v: unknown) => (v === undefined ? "-" : String(v))
          }
        ];

        if (data.pairs) {
          // Single provider response
          const pairs = data.pairs as Record<string, unknown>[];
          console.log(`\n  Provider: ${data.provider}  (${data.count} pairs)\n`);
          formatTable(pairs, pairColumns);
        } else {
          // All providers — tool returns `pairs_by_provider`
          const grouped =
            (data.pairs_by_provider ?? data.providers ?? {}) as Record<string, unknown>;
          for (const [provider, pairList] of Object.entries(grouped)) {
            const pairs = (pairList ?? []) as Record<string, unknown>[];
            console.log(`\n  Provider: ${provider}  (${pairs.length} pairs)\n`);
            formatTable(pairs, pairColumns);
          }
          if (Object.keys(grouped).length === 0) {
            console.log("\n  No trading pairs found.\n");
          }
        }
      }
    });
}

// ---------------------------------------------------------------------------
// Shared formatter for unsigned-tx results
// ---------------------------------------------------------------------------

function formatUnsignedTxResult(data: Record<string, unknown>): void {
  const tx = data.unsigned_tx as Record<string, unknown> | undefined;
  const warnings = (data.warnings ?? []) as string[];

  formatKeyValue(
    {
      intent: data.intent,
      human_summary: data.human_summary,
      tx_to: tx?.to,
      tx_value: tx?.value,
      tx_chainId: tx?.chainId,
      tx_data: truncateHex(tx?.data as string | undefined),
      tx_gas: tx?.gas ?? "auto",
      built_at: data.built_at_utc
    },
    {
      labels: {
        intent: "Intent",
        human_summary: "Summary",
        tx_to: "To",
        tx_value: "Value (hex)",
        tx_chainId: "Chain ID",
        tx_data: "Calldata",
        tx_gas: "Gas Limit",
        built_at: "Built At"
      }
    }
  );

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
