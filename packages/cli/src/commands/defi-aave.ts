import type { Command } from "commander";
import { allTools } from "@0xwh1sker/mantle-core/tools/index.js";
import { formatKeyValue, formatTable, formatJson } from "../formatter.js";

const VALID_RATE_MODES = [1, 2] as const;

function parseRateMode(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || !VALID_RATE_MODES.includes(parsed as 1 | 2)) {
    throw new Error(
      `Invalid --interest-rate-mode '${value}'. Must be 1 (stable) or 2 (variable).`
    );
  }
  return parsed;
}

/**
 * Aave V3 lending operations:
 *   aave supply   — Build unsigned supply (deposit) transaction
 *   aave borrow   — Build unsigned borrow transaction
 *   aave repay    — Build unsigned repay transaction
 *   aave withdraw — Build unsigned withdraw transaction
 *   aave markets  — Show lending market metrics (alias for defi lending-markets)
 */
export function registerAave(parent: Command): void {
  const group = parent
    .command("aave")
    .description("Aave V3 lending operations (build unsigned transactions)");

  // ── supply ──────────────────────────────────────────────────────────
  group
    .command("supply")
    .description(
      "Build unsigned Aave V3 supply (deposit) transaction. " +
      "Approve the asset for the Pool contract first."
    )
    .requiredOption("--asset <token>", "token symbol or address to supply")
    .requiredOption("--amount <amount>", "decimal amount to supply")
    .requiredOption("--on-behalf-of <address>", "address that receives aTokens (typically sender)")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_buildAaveSupply"].handler({
        asset: opts.asset,
        amount: String(opts.amount),
        on_behalf_of: opts.onBehalfOf,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatAaveResult(result as Record<string, unknown>);
      }
    });

  // ── borrow ──────────────────────────────────────────────────────────
  group
    .command("borrow")
    .description(
      "Build unsigned Aave V3 borrow transaction. " +
      "Requires sufficient collateral deposited first."
    )
    .requiredOption("--asset <token>", "token symbol or address to borrow")
    .requiredOption("--amount <amount>", "decimal amount to borrow")
    .requiredOption("--on-behalf-of <address>", "borrower address (must have collateral)")
    .option(
      "--interest-rate-mode <mode>",
      "2 = variable (default), 1 = stable",
      (v: string) => parseRateMode(v),
      2
    )
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_buildAaveBorrow"].handler({
        asset: opts.asset,
        amount: String(opts.amount),
        on_behalf_of: opts.onBehalfOf,
        interest_rate_mode: opts.interestRateMode,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatAaveResult(result as Record<string, unknown>);
      }
    });

  // ── repay ───────────────────────────────────────────────────────────
  group
    .command("repay")
    .description(
      "Build unsigned Aave V3 repay transaction. " +
      "Use --amount max to repay full debt. Approve the asset for Pool first."
    )
    .requiredOption("--asset <token>", "token symbol or address to repay")
    .requiredOption("--amount <amount>", "decimal amount to repay, or 'max' for full debt")
    .requiredOption("--on-behalf-of <address>", "borrower whose debt to repay")
    .option(
      "--interest-rate-mode <mode>",
      "2 = variable (default), 1 = stable",
      (v: string) => parseRateMode(v),
      2
    )
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_buildAaveRepay"].handler({
        asset: opts.asset,
        amount: String(opts.amount),
        on_behalf_of: opts.onBehalfOf,
        interest_rate_mode: opts.interestRateMode,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatAaveResult(result as Record<string, unknown>);
      }
    });

  // ── withdraw ────────────────────────────────────────────────────────
  group
    .command("withdraw")
    .description(
      "Build unsigned Aave V3 withdraw transaction. " +
      "Use --amount max to withdraw entire balance. May lower health factor."
    )
    .requiredOption("--asset <token>", "token symbol or address to withdraw")
    .requiredOption("--amount <amount>", "decimal amount to withdraw, or 'max' for full balance")
    .requiredOption("--to <address>", "address to receive the withdrawn tokens")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_buildAaveWithdraw"].handler({
        asset: opts.asset,
        amount: String(opts.amount),
        to: opts.to,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatAaveResult(result as Record<string, unknown>);
      }
    });

  // ── set-collateral ──────────────────────────────────────────────────
  group
    .command("set-collateral")
    .description(
      "Build unsigned Aave V3 transaction to enable/disable a supplied asset as collateral. " +
      "The tx operates on msg.sender (the signing wallet). " +
      "Use --user for preflight diagnostics (checks aToken balance, LTV, collateral status)."
    )
    .requiredOption("--asset <token>", "token symbol or address")
    .option("--user <address>", "wallet address for preflight diagnostics (not encoded in tx)")
    .option("--disable", "disable as collateral (default: enable)")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_buildAaveSetCollateral"].handler({
        asset: opts.asset,
        user: opts.user,
        use_as_collateral: !opts.disable,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatAaveResult(result as Record<string, unknown>);
      }
    });

  // ── positions ───────────────────────────────────────────────────────
  group
    .command("positions")
    .description(
      "Read a wallet's Aave V3 positions: supplied collateral, borrowed debt, " +
      "health factor, and per-reserve breakdowns."
    )
    .requiredOption("--user <address>", "wallet address to query")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_getAavePositions"].handler({
        user: opts.user,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown> | undefined;
        if (!data || !data.account) {
          console.log("\n  Error: unexpected response from Aave positions query.\n");
          return;
        }
        const account = data.account as Record<string, unknown>;

        formatKeyValue(
          {
            user: data.user,
            network: data.network,
            health_factor: account.health_factor ?? "∞ (no debt)",
            health_status: account.health_status,
            total_collateral_usd: `$${account.total_collateral_usd}`,
            total_debt_usd: `$${account.total_debt_usd}`,
            available_borrows_usd: `$${account.available_borrows_usd}`,
            ltv_bps: account.ltv_bps,
            liquidation_threshold_bps: account.current_liquidation_threshold_bps
          },
          {
            labels: {
              user: "User",
              network: "Network",
              health_factor: "Health Factor",
              health_status: "Health Status",
              total_collateral_usd: "Total Collateral",
              total_debt_usd: "Total Debt",
              available_borrows_usd: "Available Borrows",
              ltv_bps: "LTV (bps)",
              liquidation_threshold_bps: "Liq Threshold (bps)"
            }
          }
        );

        const positions = (data.positions ?? []) as Record<string, unknown>[];
        if (positions.length > 0) {
          console.log("\n  Per-Reserve Positions:");
          formatTable(positions, [
            { key: "symbol", label: "Asset" },
            { key: "supplied", label: "Supplied", align: "right" },
            { key: "variable_debt", label: "Var Debt", align: "right" },
            { key: "stable_debt", label: "Stable Debt", align: "right",
              format: (v) => v === "0.0" || v === "0" ? "-" : String(v) },
            { key: "total_debt", label: "Total Debt", align: "right" },
            {
              key: "collateral_enabled",
              label: "Collateral",
              format: (v) => (v === true ? "YES" : v === false ? "NO" : "?")
            },
            {
              key: "isolation_mode",
              label: "Isolation",
              format: (v) => (v ? "YES" : "-")
            }
          ]);
        } else {
          console.log("\n  No Aave V3 positions found.\n");
        }

        if (data.possible_missing_reserves) {
          console.log(`  WARNING: ${data.possible_missing_reserves_note}\n`);
        }
      }
    });

  // ── markets (convenience alias) ────────────────────────────────────
  group
    .command("markets")
    .description("Aave V3 lending market metrics (shortcut for defi lending-markets)")
    .option("--asset <asset>", "optional asset filter (symbol or address)")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_getLendingMarkets"].handler({
        protocol: "aave_v3",
        asset: opts.asset,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        const markets = (data.markets ?? []) as Record<string, unknown>[];
        formatTable(markets, [
          { key: "asset", label: "Asset" },
          { key: "supply_apy", label: "Supply APY%", align: "right" },
          { key: "borrow_apy_variable", label: "Borrow APY%", align: "right" },
          {
            key: "tvl_usd",
            label: "TVL (USD)",
            align: "right",
            format: (v) => (v === null ? "N/A" : `$${Number(v).toLocaleString()}`)
          },
          { key: "ltv", label: "LTV%", align: "right" },
          { key: "liquidation_threshold", label: "Liq Threshold%", align: "right" },
          {
            key: "isolation_mode",
            label: "Isolation",
            format: (v) => (v ? "YES" : "-")
          },
          {
            key: "borrowable_in_isolation",
            label: "Iso-Borrow",
            format: (v) => (v ? "YES" : "-")
          }
        ]);
      }
    });
}

// ---------------------------------------------------------------------------
// Shared formatter for Aave unsigned-tx results
// ---------------------------------------------------------------------------

function formatAaveResult(data: Record<string, unknown>): void {
  const tx = data.unsigned_tx as Record<string, unknown> | undefined;
  const warnings = (data.warnings ?? []) as string[];
  const aaveReserve = data.aave_reserve as Record<string, unknown> | undefined;

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

  if (aaveReserve) {
    fields.aave_asset = aaveReserve.symbol;
    fields.aave_underlying = aaveReserve.underlying;
    fields.aave_aToken = aaveReserve.aToken;
    fields.aave_debtToken = aaveReserve.variableDebtToken;
    labels.aave_asset = "Aave Asset";
    labels.aave_underlying = "Underlying";
    labels.aave_aToken = "aToken";
    labels.aave_debtToken = "Variable Debt Token";
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
  if (hex.length <= 66) return hex;
  return `${hex.slice(0, 34)}...${hex.slice(-16)} (${hex.length} chars)`;
}
