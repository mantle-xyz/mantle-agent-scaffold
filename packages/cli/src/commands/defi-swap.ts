import type { Command } from "commander";
import { allTools } from "@mantleio/mantle-core/tools/index.js";
import {
  formatTable,
  formatJson,
  formatUnsignedTx,
  type ExtraTxField
} from "../formatter.js";
import { parseNumberOption, parseIntegerOption } from "../utils.js";

/**
 * DEX swap & token operations:
 *   swap build-swap   — Build unsigned swap transaction
 *   swap wrap-mnt     — Build unsigned wrap MNT → WMNT
 *   swap unwrap-mnt   — Build unsigned unwrap WMNT → MNT
 *   swap pairs        — List known trading pairs & pool parameters
 *
 * Note: `approve` has been hoisted to the top level (`mantle-cli approve`)
 * since approvals are required across DeFi (swap, LP, Aave), not just swaps.
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
    .option(
      "--minimum-out <amount>",
      [
        "Minimum acceptable output amount. Accepts either:",
        "  • raw integer units   — copy 'minimum_out_raw' from swap-quote verbatim",
        "  • decimal string      — e.g. '0.000212195471425023'",
        "RECOMMENDED: --minimum-out <minimum_out_raw from swap-quote>",
        "Example: --minimum-out 212195471425023",
        "      or: --minimum-out 0.000212195471425023"
      ].join("\n")
    )
    .option(
      "--amount-out-min <amount>",
      "(alias for --minimum-out, kept for backward compatibility)"
    )
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
    .requiredOption(
      "--owner <address>",
      "signer wallet (token_in holder). Required for deterministic nonce/gas pinning and blocking INSUFFICIENT_ALLOWANCE check."
    )
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      // --minimum-out is the canonical flag; --amount-out-min is a backward-
      // compatible alias. Prefer minimumOut when both are provided.
      const amountOutMinRaw = opts.minimumOut ?? opts.amountOutMin;
      const result = await allTools["mantle_buildSwap"].handler({
        provider: opts.provider,
        token_in: opts.in,
        token_out: opts.out,
        amount_in: String(opts.amount),
        recipient: opts.recipient,
        amount_out_min: amountOutMinRaw ? String(amountOutMinRaw) : undefined,
        slippage_bps: opts.slippageBps,
        fee_tier: opts.feeTier,
        bin_step: opts.binStep,
        quote_provider: opts.quoteProvider,
        quote_fee_tier: opts.quoteFeeTier,
        quote_bin_step: opts.quoteBinStep,
        owner: opts.owner,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatSwapResult(result as Record<string, unknown>);
      }
    });

  // ── wrap-mnt ────────────────────────────────────────────────────────
  group
    .command("wrap-mnt")
    .description("Build an unsigned wrap MNT → WMNT transaction")
    .requiredOption("--amount <amount>", "decimal amount of MNT to wrap")
    .requiredOption("--sender <address>", "signer wallet. Required for deterministic nonce/gas pinning.")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_buildWrapMnt"].handler({
        amount: String(opts.amount),
        sender: opts.sender,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatUnsignedTx(result as Record<string, unknown>);
      }
    });

  // ── unwrap-mnt ──────────────────────────────────────────────────────
  group
    .command("unwrap-mnt")
    .description("Build an unsigned unwrap WMNT → MNT transaction")
    .requiredOption("--amount <amount>", "decimal amount of WMNT to unwrap")
    .requiredOption("--sender <address>", "signer wallet (WMNT holder). Required for deterministic nonce/gas pinning.")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_buildUnwrapMnt"].handler({
        amount: String(opts.amount),
        sender: opts.sender,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatUnsignedTx(result as Record<string, unknown>);
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
// build-swap-specific formatter — adds pool_params extras onto the shared
// unsigned-tx renderer.
// ---------------------------------------------------------------------------

function formatSwapResult(data: Record<string, unknown>): void {
  const poolParams = data.pool_params as Record<string, unknown> | undefined;
  const extraFields: ExtraTxField[] = [];
  if (poolParams) {
    if (poolParams.provider != null) {
      extraFields.push({ key: "pool_provider", label: "Pool Provider", value: poolParams.provider });
    }
    if (poolParams.fee_tier != null) {
      extraFields.push({ key: "pool_fee_tier", label: "Pool Fee Tier", value: poolParams.fee_tier });
    }
    if (poolParams.bin_step != null) {
      extraFields.push({ key: "pool_bin_step", label: "Pool Bin Step", value: poolParams.bin_step });
    }
  }
  const sp = data.slippage_protection as Record<string, unknown> | undefined;
  if (sp) {
    extraFields.push({ key: "sp_input", label: "Min-Out Input", value: sp.input_raw_or_decimal });
    extraFields.push({ key: "sp_raw", label: "Min-Out Raw", value: sp.resolved_raw });
    extraFields.push({ key: "sp_decimal", label: "Min-Out Decimal", value: sp.resolved_decimal });
  }
  formatUnsignedTx(data, { extraFields });
}
