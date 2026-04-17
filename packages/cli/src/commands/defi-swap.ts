import type { Command } from "commander";
import { allTools } from "@mantleio/mantle-core/tools/index.js";
import { formatKeyValue, formatTable, formatJson } from "../formatter.js";
import { parseNumberOption, parseIntegerOption } from "../utils.js";
import { runWithDryRunGuard } from "./dry-run.js";

/**
 * DEX swap & token operations:
 *   swap build-swap   — Build unsigned swap transaction
 *   swap wrap-mnt     — Build unsigned wrap MNT → WMNT
 *   swap unwrap-mnt   — Build unsigned unwrap WMNT → MNT
 *   swap pairs        — List known trading pairs & pool parameters
 *
 * Note: `approve` has been hoisted to the top level (`mantle-cli approve`)
 * since approvals are required across DeFi (swap, LP, Aave), not just swaps.
 *
 * CONFIRMATION FLOW: build-swap, wrap-mnt, unwrap-mnt require a two-step
 * confirmation process:
 *   Step 1: --dry-run   → preview + confirmation_token (no calldata generated)
 *   Step 2: --confirm --token <tok>  → full unsigned_tx
 */
export function registerSwap(parent: Command): void {
  const group = parent
    .command("swap")
    .description("DEX swap & token operations (build unsigned transactions)");

  // ── build-swap ──────────────────────────────────────────────────────
  group
    .command("build-swap")
    .description(
      "Build an unsigned swap transaction for Agni, Fluxion, or Merchant Moe. " +
      "Requires a two-step confirmation: run with --dry-run first to preview and get a " +
      "confirmation token, then re-run with --confirm --token <token>."
    )
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
      "LB bin step (1, 2, 25). Auto-resolved from known pairs",
      (v: string) => parseIntegerOption(v, "--bin-step")
    )
    .option("--quote-provider <provider>", "Provider from a prior swap-quote (for cross-validation)")
    .option(
      "--quote-fee-tier <tier>",
      "Fee tier from prior quote's resolved_pool_params (for cross-validation)",
      (v: string) => parseIntegerOption(v, "--quote-fee-tier")
    )
    .option(
      "--quote-bin-step <step>",
      "Bin step from prior quote's resolved_pool_params (for cross-validation)",
      (v: string) => parseIntegerOption(v, "--quote-bin-step")
    )
    .option(
      "--owner <address>",
      "wallet address that owns token_in — enables blocking INSUFFICIENT_ALLOWANCE check (prevents STF reverts)"
    )
    // ── Two-step confirmation flags ──────────────────────────────────────
    .option("--dry-run", "Preview the swap without generating calldata. Returns a confirmation token.")
    .option("--confirm", "Execute after a dry-run. Must be combined with --token <token>.")
    .option("--token <token>", "Confirmation token returned by a prior --dry-run invocation.")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const toolArgs = {
        provider: opts.provider,
        token_in: opts.in,
        token_out: opts.out,
        amount_in: String(opts.amount),
        recipient: opts.recipient,
        amount_out_min: opts.amountOutMin ? String(opts.amountOutMin) : undefined,
        slippage_bps: opts.slippageBps,
        fee_tier: opts.feeTier,
        bin_step: opts.binStep,
        quote_provider: opts.quoteProvider,
        quote_fee_tier: opts.quoteFeeTier,
        quote_bin_step: opts.quoteBinStep,
        owner: opts.owner,
        network: globals.network
      };

      await runWithDryRunGuard({
        dryRun: Boolean(opts.dryRun),
        confirm: Boolean(opts.confirm),
        token: opts.token as string | undefined,
        hashParams: {
          command: "build-swap",
          provider: opts.provider,
          in: opts.in,
          out: opts.out,
          amount: opts.amount,
          recipient: opts.recipient,
          amountOutMin: opts.amountOutMin,
          slippageBps: opts.slippageBps,
          feeTier: opts.feeTier,
          binStep: opts.binStep,
          owner: opts.owner,
          network: globals.network
        },
        handler: () => allTools["mantle_buildSwap"].handler(toolArgs) as Promise<Record<string, unknown>>,
        isJson: Boolean(globals.json),
        formatHuman: (result) => formatUnsignedTxResult(result)
      });
    });

  // ── wrap-mnt ────────────────────────────────────────────────────────
  group
    .command("wrap-mnt")
    .description(
      "Build an unsigned wrap MNT → WMNT transaction. " +
      "Requires --dry-run first, then --confirm --token <token>."
    )
    .requiredOption("--amount <amount>", "decimal amount of MNT to wrap")
    .option("--dry-run", "Preview without generating calldata. Returns a confirmation token.")
    .option("--confirm", "Execute after a dry-run. Must be combined with --token <token>.")
    .option("--token <token>", "Confirmation token returned by a prior --dry-run invocation.")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const toolArgs = {
        amount: String(opts.amount),
        network: globals.network
      };

      await runWithDryRunGuard({
        dryRun: Boolean(opts.dryRun),
        confirm: Boolean(opts.confirm),
        token: opts.token as string | undefined,
        hashParams: { command: "wrap-mnt", amount: opts.amount, network: globals.network },
        handler: () => allTools["mantle_buildWrapMnt"].handler(toolArgs) as Promise<Record<string, unknown>>,
        isJson: Boolean(globals.json),
        formatHuman: (result) => formatUnsignedTxResult(result)
      });
    });

  // ── unwrap-mnt ──────────────────────────────────────────────────────
  group
    .command("unwrap-mnt")
    .description(
      "Build an unsigned unwrap WMNT → MNT transaction. " +
      "Requires --dry-run first, then --confirm --token <token>."
    )
    .requiredOption("--amount <amount>", "decimal amount of WMNT to unwrap")
    .option("--dry-run", "Preview without generating calldata. Returns a confirmation token.")
    .option("--confirm", "Execute after a dry-run. Must be combined with --token <token>.")
    .option("--token <token>", "Confirmation token returned by a prior --dry-run invocation.")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const toolArgs = {
        amount: String(opts.amount),
        network: globals.network
      };

      await runWithDryRunGuard({
        dryRun: Boolean(opts.dryRun),
        confirm: Boolean(opts.confirm),
        token: opts.token as string | undefined,
        hashParams: { command: "unwrap-mnt", amount: opts.amount, network: globals.network },
        handler: () => allTools["mantle_buildUnwrapMnt"].handler(toolArgs) as Promise<Record<string, unknown>>,
        isJson: Boolean(globals.json),
        formatHuman: (result) => formatUnsignedTxResult(result)
      });
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
  const poolParams = data.pool_params as Record<string, unknown> | undefined;

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

  if (poolParams) {
    if (poolParams.provider) { fields.pool_provider = poolParams.provider; labels.pool_provider = "Pool Provider"; }
    if (poolParams.fee_tier != null) { fields.pool_fee_tier = poolParams.fee_tier; labels.pool_fee_tier = "Pool Fee Tier"; }
    if (poolParams.bin_step != null) { fields.pool_bin_step = poolParams.bin_step; labels.pool_bin_step = "Pool Bin Step"; }
  }

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
  // Never truncate calldata — agents and users need the full hex to sign transactions.
  // Previously this sliced the middle out, causing manual-paste errors (e.g. dropped chars).
  if (hex.length <= 66) return hex;
  return `${hex} (${hex.length} chars)`;
}
