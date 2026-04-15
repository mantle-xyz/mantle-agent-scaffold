import type { Command } from "commander";
import { allTools } from "@mantleio/mantle-core/tools/index.js";
import { formatKeyValue, formatTable, formatJson } from "../formatter.js";
import { parseIntegerOption, parseNumberOption, parseJsonArray } from "../utils.js";

/**
 * Liquidity provision operations:
 *   lp add           — Build unsigned add-liquidity transaction
 *   lp remove        — Build unsigned remove-liquidity transaction
 *   lp positions     — List V3 LP positions for an owner
 *   lp pool-state    — Read V3 pool on-chain state (tick, price, liquidity)
 *   lp analyze       — Deep pool analysis (APR, risk, investment projections)
 *   lp collect-fees  — Build unsigned fee collection transaction
 *   lp suggest-ticks — Suggest tick ranges for V3 LP
 */
export function registerLp(parent: Command): void {
  const group = parent
    .command("lp")
    .description("Liquidity provision operations (build unsigned transactions)");

  // ── add ─────────────────────────────────────────────────────────────
  group
    .command("add")
    .description(
      "Build unsigned add-liquidity transaction. " +
      "V3 (agni/fluxion) mints an NFT position; Merchant Moe LB adds to bins.\n" +
      "Amount modes: provide --amount-a + --amount-b, OR --amount-usd for automatic sizing.\n" +
      "Range presets: --range-preset aggressive (±5%) | moderate (±10%) | conservative (±20%)."
    )
    .requiredOption("--provider <provider>", "DEX provider: agni, fluxion, or merchant_moe")
    .requiredOption("--token-a <token>", "first token symbol or address")
    .requiredOption("--token-b <token>", "second token symbol or address")
    .option("--amount-a <amount>", "decimal amount of token A (required unless --amount-usd is used)")
    .option("--amount-b <amount>", "decimal amount of token B (required unless --amount-usd is used)")
    .option(
      "--amount-usd <usd>",
      "USD amount to invest (auto-splits between tokens using live prices and pool state)",
      (v: string) => parseNumberOption(v, "--amount-usd")
    )
    .requiredOption("--recipient <address>", "address to receive LP position")
    .option(
      "--slippage-bps <bps>",
      "slippage tolerance in basis points (default: 50)",
      (v: string) => parseIntegerOption(v, "--slippage-bps")
    )
    .option(
      "--fee-tier <tier>",
      "V3 fee tier (default: 3000). For agni/fluxion",
      (v: string) => parseNumberOption(v, "--fee-tier")
    )
    .option(
      "--tick-lower <tick>",
      "lower tick bound. For agni/fluxion. Overrides --range-preset. Default: full range",
      (v: string) => parseIntegerOption(v, "--tick-lower")
    )
    .option(
      "--tick-upper <tick>",
      "upper tick bound. For agni/fluxion. Overrides --range-preset. Default: full range",
      (v: string) => parseIntegerOption(v, "--tick-upper")
    )
    .option(
      "--range-preset <preset>",
      "price range preset: aggressive (±5%), moderate (±10%), conservative (±20%). " +
      "Auto-computes tick bounds (V3) or bin spread (LB) from current pool price. " +
      "Overridden by explicit --tick-lower/--tick-upper."
    )
    .option(
      "--bin-step <step>",
      "LB bin step (default: 25). For merchant_moe",
      (v: string) => parseIntegerOption(v, "--bin-step")
    )
    .option(
      "--active-id <id>",
      "active bin ID. For merchant_moe",
      (v: string) => parseIntegerOption(v, "--active-id")
    )
    .option(
      "--id-slippage <slippage>",
      "bin ID slippage tolerance. For merchant_moe",
      (v: string) => parseIntegerOption(v, "--id-slippage")
    )
    .option("--delta-ids <json>", "relative bin IDs as JSON array. For merchant_moe")
    .option("--distribution-x <json>", "token X distribution per bin as JSON array. For merchant_moe")
    .option("--distribution-y <json>", "token Y distribution per bin as JSON array. For merchant_moe")
    .option("--owner <address>", "wallet address that will sign (enables blocking allowance check)")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const hasTokenAmounts = opts.amountA != null && opts.amountB != null;
      const hasUsdAmount = opts.amountUsd != null;
      if (!hasTokenAmounts && !hasUsdAmount) {
        throw new Error(
          "Provide either (--amount-a + --amount-b) or --amount-usd."
        );
      }
      const result = await allTools["mantle_buildAddLiquidity"].handler({
        provider: opts.provider,
        token_a: opts.tokenA,
        token_b: opts.tokenB,
        amount_a: opts.amountA != null ? String(opts.amountA) : undefined,
        amount_b: opts.amountB != null ? String(opts.amountB) : undefined,
        amount_usd: opts.amountUsd,
        recipient: opts.recipient,
        owner: opts.owner,
        slippage_bps: opts.slippageBps,
        fee_tier: opts.feeTier,
        tick_lower: opts.tickLower,
        tick_upper: opts.tickUpper,
        range_preset: opts.rangePreset,
        bin_step: opts.binStep,
        active_id: opts.activeId,
        id_slippage: opts.idSlippage,
        delta_ids: opts.deltaIds ? parseJsonArray(opts.deltaIds as string, "--delta-ids") : undefined,
        distribution_x: opts.distributionX
          ? parseJsonArray(opts.distributionX as string, "--distribution-x")
          : undefined,
        distribution_y: opts.distributionY
          ? parseJsonArray(opts.distributionY as string, "--distribution-y")
          : undefined,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatUnsignedTxResult(result as Record<string, unknown>);
      }
    });

  // ── remove ──────────────────────────────────────────────────────────
  group
    .command("remove")
    .description(
      "Build unsigned remove-liquidity transaction. " +
      "V3 uses decreaseLiquidity+collect; Merchant Moe LB removes from bins.\n" +
      "V3 amount modes: --liquidity (exact) or --percentage (1-100, reads position on-chain)."
    )
    .requiredOption("--provider <provider>", "DEX provider: agni, fluxion, or merchant_moe")
    .requiredOption("--recipient <address>", "address to receive withdrawn tokens")
    .option("--token-id <id>", "V3 NFT position token ID. For agni/fluxion")
    .option("--liquidity <amount>", "exact amount of liquidity to remove. For agni/fluxion")
    .option(
      "--percentage <pct>",
      "percentage of position to remove (1-100). Works for both V3 (agni/fluxion) and Merchant Moe. Reads LP balances on-chain.",
      (v: string) => parseNumberOption(v, "--percentage")
    )
    .option("--token-a <token>", "first token symbol or address. For merchant_moe")
    .option("--token-b <token>", "second token symbol or address. For merchant_moe")
    .option(
      "--bin-step <step>",
      "LB bin step. For merchant_moe",
      (v: string) => parseIntegerOption(v, "--bin-step")
    )
    .option("--ids <json>", "bin IDs to remove from as JSON array. For merchant_moe. Optional with --percentage.")
    .option("--amounts <json>", "LP token balances (balance_raw) per bin as JSON array of strings. For merchant_moe. Use --percentage instead for automatic mode.")
    .option("--owner <address>", "wallet address that holds the LP tokens (the signer). For merchant_moe percentage mode when signer differs from recipient.")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const provider = String(opts.provider).toLowerCase();

      // V3 providers require --token-id and either --liquidity or --percentage
      if (provider === "agni" || provider === "fluxion") {
        if (!opts.tokenId) {
          throw new Error("--token-id is required for V3 providers (agni/fluxion).");
        }
        if (!opts.liquidity && opts.percentage == null) {
          throw new Error(
            "--liquidity or --percentage is required for V3 providers (agni/fluxion). " +
            "Use --percentage 100 to remove the full position."
          );
        }
        if (opts.liquidity && opts.percentage != null) {
          throw new Error(
            "--liquidity and --percentage are mutually exclusive. Use one or the other."
          );
        }
        if (opts.liquidity) {
          const liq = BigInt(opts.liquidity as string);
          if (liq <= 0n) {
            throw new Error(
              "--liquidity must be a positive value. " +
              "A zero-liquidity removal would produce a no-op or fee-collect-only transaction."
            );
          }
        }
      }

      // Merchant Moe requires token_a, token_b, and either --percentage or --ids+--amounts
      if (provider === "merchant_moe") {
        if (!opts.tokenA || !opts.tokenB) {
          throw new Error("--token-a and --token-b are required for merchant_moe.");
        }
        if (opts.percentage == null && !opts.ids && !opts.amounts) {
          throw new Error(
            "--percentage or --ids+--amounts is required for merchant_moe. " +
            "Recommended: use --percentage 100 to remove all LP (auto-reads balances on-chain)."
          );
        }
        if (opts.percentage != null && opts.amounts) {
          throw new Error(
            "--percentage and --amounts are mutually exclusive. Use one or the other."
          );
        }
      }

      const result = await allTools["mantle_buildRemoveLiquidity"].handler({
        provider: opts.provider,
        recipient: opts.recipient,
        owner: opts.owner,
        token_id: opts.tokenId,
        liquidity: opts.liquidity,
        percentage: opts.percentage,
        token_a: opts.tokenA,
        token_b: opts.tokenB,
        bin_step: opts.binStep,
        ids: opts.ids ? parseJsonArray(opts.ids as string, "--ids") : undefined,
        amounts: opts.amounts ? parseJsonArray(opts.amounts as string, "--amounts") : undefined,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatUnsignedTxResult(result as Record<string, unknown>);
      }
    });

  // ── positions ───────────────────────────────────────────────────────
  // TEMPORARILY DISABLED: Agni's NonfungiblePositionManager lacks
  // ERC721Enumerable. Re-enable once a reliable enumeration strategy
  // (subgraph or paginated event scanning) is implemented.
  group
    .command("positions")
    .description("[DISABLED] List V3 LP positions for an owner across Agni and Fluxion")
    // NOTE: --owner is intentionally `.option` (not `.requiredOption`) so users
    // who run `mantle-cli lp positions` without flags still see the friendly
    // disabled message below instead of a "missing required option" error.
    .option("--owner <address>", "wallet address to query (ignored — command is disabled)")
    .option("--provider <provider>", "filter by provider: agni or fluxion")
    .option("--include-empty", "include zero-liquidity positions", false)
    .action(async () => {
      console.error(
        "\n  This command is temporarily disabled.\n\n" +
        "  Agni's NonfungiblePositionManager does not implement ERC721Enumerable,\n" +
        "  so on-chain position enumeration is unreliable. A fix using subgraph\n" +
        "  or paginated event scanning is in progress.\n\n" +
        "  Workaround: check positions on https://agni.finance or via Mantlescan.\n"
      );
      process.exitCode = 1;
    });

  // ── lb-positions ────────────────────────────────────────────────────
  group
    .command("lb-positions")
    .description(
      "Scan Merchant Moe Liquidity Book LP positions for a wallet. " +
      "Checks known LB pairs around the active bin (+-25 bins)."
    )
    .requiredOption("--owner <address>", "wallet address to query")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_getLBPositions"].handler({
        owner: opts.owner,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown> | undefined;
        if (!data) { console.log("\n  Error: no data returned.\n"); return; }
        const positions = (data.positions ?? []) as Record<string, unknown>[];
        // Show coverage warning BEFORE results (F-02)
        if (data.note) {
          console.log(`\n  Note: ${data.note}`);
        }
        if (positions.length === 0) {
          console.log("\n  No Merchant Moe LB positions found within scan range.\n");
        } else {
          for (const pos of positions) {
            const tokenX = (pos.token_x ?? {}) as Record<string, unknown>;
            const tokenY = (pos.token_y ?? {}) as Record<string, unknown>;
            console.log(
              `\n  ${tokenX.symbol ?? "?"}/${tokenY.symbol ?? "?"} (bin step: ${pos.bin_step}) — ` +
              `${pos.total_bins_with_liquidity} bins with liquidity`
            );
            const bins = (pos.bins ?? []) as Record<string, unknown>[];
            formatTable(bins, [
              { key: "bin_id", label: "Bin ID", align: "right" },
              { key: "share_pct", label: "Share %", align: "right",
                format: (v) => v != null ? `${v}%` : "?" },
              { key: "user_amount_x", label: `Amount ${tokenX.symbol ?? "X"}`, align: "right",
                format: (v) => v != null ? String(v) : "?" },
              { key: "user_amount_y", label: `Amount ${tokenY.symbol ?? "Y"}`, align: "right",
                format: (v) => v != null ? String(v) : "?" }
            ]);
          }
          console.log();
        }
      }
    });

  // ── pool-state ──────────────────────────────────────────────────────
  group
    .command("pool-state")
    .description("Read V3 pool on-chain state (tick, price, liquidity)")
    .option("--pool <address>", "pool contract address (or use --token-a/--token-b/--fee-tier)")
    .option("--token-a <token>", "first token symbol or address")
    .option("--token-b <token>", "second token symbol or address")
    .option(
      "--fee-tier <tier>",
      "V3 fee tier",
      (v: string) => parseNumberOption(v, "--fee-tier")
    )
    .option("--provider <provider>", "DEX provider: agni or fluxion", "agni")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_getV3PoolState"].handler({
        pool_address: opts.pool,
        token_a: opts.tokenA,
        token_b: opts.tokenB,
        fee_tier: opts.feeTier,
        provider: opts.provider,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        formatKeyValue(
          {
            pool: data.pool_address,
            provider: data.provider,
            current_tick: data.current_tick,
            tick_spacing: data.tick_spacing,
            liquidity: data.pool_liquidity,
            price_0_per_1: data.price_token0_per_token1,
            price_1_per_0: data.price_token1_per_token0
          },
          {
            labels: {
              pool: "Pool",
              provider: "Provider",
              current_tick: "Current Tick",
              tick_spacing: "Tick Spacing",
              liquidity: "Pool Liquidity",
              price_0_per_1: "Price (token0/token1)",
              price_1_per_0: "Price (token1/token0)"
            }
          }
        );
      }
    });

  // ── collect-fees ────────────────────────────────────────────────────
  group
    .command("collect-fees")
    .description("Build unsigned V3 fee collection transaction")
    .requiredOption("--provider <provider>", "DEX provider: agni or fluxion")
    .requiredOption("--token-id <id>", "V3 NFT position token ID")
    .requiredOption("--recipient <address>", "address to receive collected fees")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_buildCollectFees"].handler({
        provider: opts.provider,
        token_id: opts.tokenId,
        recipient: opts.recipient,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatUnsignedTxResult(result as Record<string, unknown>);
      }
    });

  // ── suggest-ticks ───────────────────────────────────────────────────
  group
    .command("suggest-ticks")
    .description("Suggest tick ranges for V3 LP (wide/moderate/tight strategies)")
    .option("--pool <address>", "pool contract address (or use --token-a/--token-b/--fee-tier)")
    .option("--token-a <token>", "first token symbol or address")
    .option("--token-b <token>", "second token symbol or address")
    .option(
      "--fee-tier <tier>",
      "V3 fee tier",
      (v: string) => parseNumberOption(v, "--fee-tier")
    )
    .option("--provider <provider>", "DEX provider: agni or fluxion", "agni")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_suggestTickRange"].handler({
        pool_address: opts.pool,
        token_a: opts.tokenA,
        token_b: opts.tokenB,
        fee_tier: opts.feeTier,
        provider: opts.provider,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        console.log(`\n  Current Tick: ${data.current_tick}  Tick Spacing: ${data.tick_spacing}\n`);
        const suggestions = (data.suggestions ?? []) as Record<string, unknown>[];
        formatTable(suggestions, [
          { key: "strategy", label: "Strategy" },
          { key: "tick_lower", label: "Tick Lower", align: "right" },
          { key: "tick_upper", label: "Tick Upper", align: "right" },
          {
            key: "price_lower",
            label: "Price Lower",
            align: "right",
            format: (v) => Number(v).toFixed(4)
          },
          {
            key: "price_upper",
            label: "Price Upper",
            align: "right",
            format: (v) => Number(v).toFixed(4)
          }
        ]);
      }
    });

  // ── top-pools (temporarily disabled — DexScreener rate-limit issues) ──
  group
    .command("top-pools")
    .description("[DISABLED] Discover top LP opportunities (temporarily disabled)")
    .action(async () => {
      console.error(
        "\n  This command is temporarily disabled.\n\n" +
        "  DexScreener API rate-limiting causes frequent query failures.\n" +
        "  A fix with retry/backoff logic is in progress.\n\n" +
        "  Workaround: use 'lp find-pools' for specific token pairs,\n" +
        "  or 'lp analyze' for deep pool analysis.\n"
      );
      process.exitCode = 1;
    });

  // ── find-pools ──────────────────────────────────────────────────────
  group
    .command("find-pools")
    .description(
      "Discover all available pools for a token pair across Agni, Fluxion, and Merchant Moe. " +
      "Queries factory contracts on-chain — the authoritative source."
    )
    .requiredOption("--token-a <token>", "first token symbol or address")
    .requiredOption("--token-b <token>", "second token symbol or address")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_findPools"].handler({
        token_a: opts.tokenA,
        token_b: opts.tokenB,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        const tokenA = data.token_a as Record<string, unknown>;
        const tokenB = data.token_b as Record<string, unknown>;
        console.log(
          `\n  ${tokenA.symbol}/${tokenB.symbol} — ` +
          `${data.with_liquidity} pools with liquidity (${data.total_found} total)\n`
        );
        const pools = (data.pools ?? []) as Record<string, unknown>[];
        formatTable(pools, [
          { key: "provider", label: "DEX" },
          {
            key: "fee_tier",
            label: "Fee Tier",
            align: "right",
            format: (v) => v != null ? `${Number(v) / 10000}%` : "-"
          },
          {
            key: "bin_step",
            label: "Bin Step",
            align: "right",
            format: (v) => v != null ? String(v) : "-"
          },
          { key: "pool_address", label: "Pool Address" },
          {
            key: "has_liquidity",
            label: "Liquid",
            format: (v) => v === true ? "YES" : "NO"
          },
          {
            key: "liquidity_raw",
            label: "Liquidity",
            align: "right",
            format: (v) => {
              const n = BigInt(v as string);
              if (n === 0n) return "-";
              if (n > 10n ** 18n) return (Number(n / (10n ** 12n)) / 1e6).toFixed(1) + "T";
              return n.toString();
            }
          },
          {
            // Discriminant so "Liquidity" values are not visually comparable across
            // providers (V3 virtual-L vs LB mixed-decimal reserves are not the same unit).
            key: "liquidity_unit",
            label: "Unit",
            format: (v) => {
              if (v === "v3_virtual_liquidity") return "v3-L";
              if (v === "lb_active_bin_native_mixed") return "lb-bin-mixed";
              return v ? String(v) : "-";
            }
          }
        ]);
      }
    });

  // ── analyze ─────────────────────────────────────────────────────────
  group
    .command("analyze")
    .description(
      "Deep pool analysis: fee APR, multi-range comparison, risk scoring, investment projections. " +
      "Fetches 24h volume and TVL from DexScreener to compute concentrated APR across 10 range brackets."
    )
    .option("--pool <address>", "pool contract address (or use --token-a/--token-b/--fee-tier)")
    .option("--token-a <token>", "first token symbol or address")
    .option("--token-b <token>", "second token symbol or address")
    .option(
      "--fee-tier <tier>",
      "V3 fee tier",
      (v: string) => parseNumberOption(v, "--fee-tier")
    )
    .option("--provider <provider>", "DEX provider: agni or fluxion", "agni")
    .option(
      "--investment-usd <amount>",
      "USD amount to project returns for (default: 1000)",
      (v: string) => parseNumberOption(v, "--investment-usd")
    )
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_analyzePool"].handler({
        pool_address: opts.pool,
        token_a: opts.tokenA,
        token_b: opts.tokenB,
        fee_tier: opts.feeTier,
        provider: opts.provider,
        investment_usd: opts.investmentUsd,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        const market = data.market_data as Record<string, unknown>;
        const risk = data.risk as Record<string, unknown>;

        formatKeyValue(
          {
            pool: data.pool_address,
            provider: data.provider,
            fee: `${(data.fee_rate_pct as number).toFixed(2)}%`,
            tvl: market.tvl_usd != null ? `$${Number(market.tvl_usd).toLocaleString()}` : "N/A",
            volume_24h: market.volume_24h_usd != null ? `$${Number(market.volume_24h_usd).toLocaleString()}` : "N/A",
            base_fee_apr: market.base_fee_apr_pct != null ? `${market.base_fee_apr_pct}%` : "N/A",
            price_change_24h: market.price_change_24h_pct != null ? `${market.price_change_24h_pct}%` : "N/A",
            risk_overall: risk.overall,
            recommended_range: data.recommended_range ?? "N/A"
          },
          {
            labels: {
              pool: "Pool",
              provider: "Provider",
              fee: "Fee Rate",
              tvl: "TVL",
              volume_24h: "24h Volume",
              base_fee_apr: "Base Fee APR",
              price_change_24h: "24h Price Change",
              risk_overall: "Risk Level",
              recommended_range: "Recommended Range"
            }
          }
        );

        const ranges = (data.ranges ?? []) as Record<string, unknown>[];
        console.log("\n  Range Analysis:");
        formatTable(ranges, [
          { key: "label", label: "Range" },
          {
            key: "fee_apr_pct",
            label: "Fee APR",
            align: "right",
            format: (v) => `${v}%`
          },
          {
            key: "concentration_factor",
            label: "Conc. Factor",
            align: "right",
            format: (v) => `${v}x`
          },
          {
            key: "daily_fee_usd",
            label: "Daily Fee",
            align: "right",
            format: (v) => v != null ? `$${v}` : "N/A"
          },
          {
            key: "monthly_fee_usd",
            label: "Monthly Fee",
            align: "right",
            format: (v) => v != null ? `$${v}` : "N/A"
          },
          { key: "rebalance_risk", label: "Rebal. Risk" }
        ]);

        const riskDetails = (risk.details ?? []) as string[];
        if (riskDetails.length > 0) {
          console.log("\n  Risk Details:");
          for (const d of riskDetails) {
            console.log(`    - ${d}`);
          }
          console.log();
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
  // Never truncate calldata — agents and users need the full hex to sign transactions.
  // Previously this sliced the middle out, causing manual-paste errors (e.g. dropped chars).
  if (hex.length <= 66) return hex;
  return `${hex} (${hex.length} chars)`;
}
