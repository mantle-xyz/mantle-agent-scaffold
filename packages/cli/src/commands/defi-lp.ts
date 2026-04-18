import type { Command } from "commander";
import { allTools } from "@mantleio/mantle-core/tools/index.js";
import { formatKeyValue, formatTable, formatJson } from "../formatter.js";
import { parseIntegerOption, parseNumberOption, parseJsonArray, parseBigIntArray } from "../utils.js";

/**
 * Liquidity provision operations:
 *   lp add           — Build unsigned add-liquidity transaction
 *                      (aliases: add-liquidity, provide, deposit, open)
 *   lp remove        — Build unsigned remove-liquidity transaction
 *                      (aliases: remove-liquidity, withdraw, close, exit)
 *   lp approve-lb    — Build unsigned LB Pair operator approval (required before Moe remove)
 *                      (aliases: approve-lb-shares, approve-moe-shares)
 *   lp positions     — List LP positions for an owner (V3 + LB)
 *                      (aliases: list, ls, my-positions)
 *   lp pool-state    — Read V3 pool on-chain state (tick, price, liquidity)
 *                      (aliases: pool-info, pool)
 *   lp analyze       — Deep pool analysis (APR, risk, investment projections)
 *                      (aliases: analyse, pool-analysis, apr)
 *   lp collect-fees  — Build unsigned fee collection transaction
 *                      (aliases: collect, claim-fees, harvest)
 *   lp suggest-ticks — Suggest tick ranges for V3 LP
 *                      (aliases: tick-ranges, suggest-range)
 *   lp find-pools    — Discover pools for a token pair across DEXes
 *                      (aliases: pools, discover-pools)
 *
 * Group aliases: `liquidity`, `pool` — so "mantle-cli liquidity add" also routes here.
 *
 * Rich descriptions + aliases exist to improve LLM / agent routing — the command
 * descriptions include natural-language verbs (add/provide/deposit/open, remove/
 * withdraw/close/exit, list/query/show, etc.) so that requests like "add liquidity",
 * "provide LP", "open a position", "close my LP", "添加流动性" map unambiguously to
 * the right subcommand via --help introspection.
 */
export function registerLp(parent: Command): void {
  const group = parent
    .command("lp")
    .aliases(["liquidity", "pool"])
    .description(
      "Liquidity provisioning (LP) on Mantle DEXes — use for any request that involves " +
      "ADDING liquidity (provide / deposit / open a position), REMOVING liquidity " +
      "(withdraw / close a position), listing LP positions, approving LB shares, " +
      "collecting V3 fees, or analyzing / discovering pools. " +
      "Supports Agni V3, Fluxion V3, and Merchant Moe (Liquidity Book). " +
      "Subcommands: add, remove, approve-lb, positions, pool-state, find-pools, analyze, collect-fees, suggest-ticks. " +
      "All write subcommands output unsigned, deterministic transactions for an external signer."
    );

  // ── add ─────────────────────────────────────────────────────────────
  group
    .command("add")
    .aliases(["add-liquidity", "provide", "deposit", "open"])
    .description(
      "Add / provide / deposit liquidity to a DEX pool. Use this for any " +
      "\"add liquidity\", \"provide liquidity\", \"open an LP position\", or \"deposit into a pool\" request. " +
      "Builds an unsigned transaction. " +
      "V3 (agni/fluxion) mints an NFT position; Merchant Moe LB adds into bins.\n" +
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
    .requiredOption("--owner <address>", "signer wallet (token holder). Required for deterministic nonce/gas pinning and blocking allowance check.")
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
    .aliases(["remove-liquidity", "withdraw", "close", "exit"])
    .description(
      "Remove / withdraw / close liquidity from a DEX pool. Use this for any " +
      "\"remove liquidity\", \"withdraw LP\", \"close position\", or \"exit pool\" request. " +
      "Builds an unsigned transaction. " +
      "V3 uses decreaseLiquidity+collect; Merchant Moe LB burns bin shares.\n" +
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
    .requiredOption("--owner <address>", "wallet address that holds the LP tokens (the signer). Required for deterministic nonce/gas pinning.")
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
        // Use BigInt-safe parsing so large LB-token amounts (commonly >2^53)
        // don't lose precision through JSON.parse → Number rounding, which
        // would cause on-chain burn() to revert with balance mismatch.
        ids: opts.ids ? parseBigIntArray(opts.ids as string, "--ids") : undefined,
        amounts: opts.amounts ? parseBigIntArray(opts.amounts as string, "--amounts") : undefined,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatUnsignedTxResult(result as Record<string, unknown>);
      }
    });

  // ── approve-lb ──────────────────────────────────────────────────────
  group
    .command("approve-lb")
    .aliases(["approve-lb-shares", "approve-moe-shares"])
    .description(
      "Approve LB Pair operator (setApprovalForAll) for Merchant Moe LB shares. " +
      "REQUIRED before 'lp remove' on merchant_moe: the router burns your LB shares " +
      "via LBPair.burn(user,...) and needs isApprovedForAll(user, router)=true. " +
      "Resolve the pair directly via --pair, or via --token-a/--token-b/--bin-step (looked up through the LB Factory). " +
      "Not needed for Agni/Fluxion V3 positions — those use NFT-based auth."
    )
    .requiredOption("--operator <address>", "address to approve/revoke (must be whitelisted, typically the LB Router)")
    .option("--pair <address>", "LB Pair contract address (skip factory lookup)")
    .option("--token-a <token>", "first token symbol or address (alternative to --pair)")
    .option("--token-b <token>", "second token symbol or address (alternative to --pair)")
    .option(
      "--bin-step <step>",
      "LB pair bin step (alternative to --pair)",
      (v: string) => parseIntegerOption(v, "--bin-step")
    )
    .option(
      "--approved <bool>",
      "true to grant, false to revoke (default: true)",
      (v: string) => {
        const s = v.trim().toLowerCase();
        if (s === "true" || s === "1" || s === "yes") return true;
        if (s === "false" || s === "0" || s === "no") return false;
        throw new Error("--approved must be 'true' or 'false'");
      }
    )
    .requiredOption("--owner <address>", "signer wallet (LB share holder). Required for deterministic nonce/gas pinning and approval skip-check.")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      if (!opts.pair && !(opts.tokenA && opts.tokenB && opts.binStep != null)) {
        throw new Error(
          "Provide either --pair, OR all of --token-a + --token-b + --bin-step."
        );
      }
      const result = await allTools["mantle_buildSetLBApprovalForAll"].handler({
        pair: opts.pair,
        token_a: opts.tokenA,
        token_b: opts.tokenB,
        bin_step: opts.binStep,
        operator: opts.operator,
        approved: opts.approved === undefined ? true : opts.approved,
        owner: opts.owner,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatUnsignedTxResult(result as Record<string, unknown>);
      }
    });

  // ── positions ───────────────────────────────────────────────────────
  // Enumerates LP positions for an owner. Routes by --provider:
  //   merchant_moe → LB positions (ERC1155 bin balances)
  //   agni / fluxion → V3 positions (NFT enumeration via Transfer logs)
  //   omitted → scan both V3 providers (Agni + Fluxion)
  // The underlying V3 path uses Transfer-event log scanning for managers
  // that lack ERC721Enumerable (Agni). Partial scan failures surface in
  // `result.warnings`.
  group
    .command("positions")
    .aliases(["list", "ls", "my-positions"])
    .description(
      "List / query / show LP positions for an owner wallet. Use for any " +
      "\"list my LP\", \"show positions\", \"what LPs do I have\" request. " +
      "Routes by --provider: merchant_moe → LB (ERC1155 bin balances); " +
      "agni/fluxion → V3 NFT positions; omitted → scan Agni + Fluxion."
    )
    .requiredOption("--owner <address>", "wallet address to query")
    .option("--provider <provider>", "provider: merchant_moe | agni | fluxion (default: scan agni + fluxion)")
    .option("--include-empty", "include zero-liquidity V3 positions", false)
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const providerRaw = typeof opts.provider === "string" ? opts.provider.toLowerCase() : undefined;

      // ── Merchant Moe (LB) branch ───────────────────────────────────
      if (providerRaw === "merchant_moe" || providerRaw === "moe") {
        const result = await allTools["mantle_getLBPositions"].handler({
          owner: opts.owner,
          network: globals.network
        });
        if (globals.json) { formatJson(result); return; }
        const data = result as Record<string, unknown> | undefined;
        if (!data) { console.log("\n  Error: no data returned.\n"); return; }
        const positions = (data.positions ?? []) as Record<string, unknown>[];
        if (data.note) console.log(`\n  Note: ${data.note}`);
        if (positions.length === 0) {
          console.log("\n  No Merchant Moe LB positions found within scan range.\n");
          return;
        }
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
        return;
      }

      // ── V3 branch (Agni / Fluxion) ─────────────────────────────────
      const result = await allTools["mantle_getV3Positions"].handler({
        owner: opts.owner,
        provider: opts.provider,
        include_empty: opts.includeEmpty === true,
        network: globals.network
      });
      if (globals.json) { formatJson(result); return; }
      const data = result as Record<string, unknown> | undefined;
      if (!data) { console.log("\n  Error: no data returned.\n"); return; }
      const positions = (data.positions ?? []) as Record<string, unknown>[];
      const warnings = (data.warnings ?? []) as Array<{ provider: string; warning: string }>;
      const errors = (data.errors ?? []) as Array<{ provider: string; error: string }>;

      if (positions.length === 0) {
        console.log("\n  No V3 LP positions found for this owner.\n");
      } else {
        for (const pos of positions) {
          const t0 = (pos.token0 ?? {}) as Record<string, unknown>;
          const t1 = (pos.token1 ?? {}) as Record<string, unknown>;
          console.log(
            `\n  [${pos.provider}] ${t0.symbol ?? "?"}/${t1.symbol ?? "?"} ` +
            `fee=${pos.fee} token_id=${pos.token_id} ` +
            `ticks=[${pos.tick_lower},${pos.tick_upper}] ` +
            `liquidity=${pos.liquidity} ` +
            `in_range=${pos.in_range ? "yes" : "no"}`
          );
          if (pos.tokens_owed0 !== "0" || pos.tokens_owed1 !== "0") {
            console.log(
              `    uncollected fees: ${pos.tokens_owed0} ${t0.symbol ?? "token0"}, ` +
              `${pos.tokens_owed1} ${t1.symbol ?? "token1"}`
            );
          }
        }
        console.log();
      }
      if (warnings.length > 0) {
        console.log("  Warnings:");
        for (const w of warnings) console.log(`    [${w.provider}] ${w.warning}`);
        console.log();
      }
      if (errors.length > 0) {
        console.log("  Errors:");
        for (const e of errors) console.log(`    [${e.provider}] ${e.error}`);
        console.log();
        // When every provider failed and no positions came back, exit non-zero
        // so scripts/CI can distinguish "scan failed" from "wallet is empty".
        if (positions.length === 0) process.exitCode = 1;
      }
    });

  // ── lb-positions ────────────────────────────────────────────────────
  group
    .command("lb-positions")
    .aliases(["moe-positions"])
    .description(
      "Scan Merchant Moe Liquidity Book (LB) LP positions for a wallet. " +
      "Use when the user specifically asks about Moe/LB positions. " +
      "Checks known LB pairs around the active bin (±25 bins). " +
      "(For a general \"list my LP positions\" query, prefer `lp positions` which routes by --provider.)"
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
    .aliases(["pool-info", "pool"])
    .description(
      "Read / inspect V3 pool on-chain state — current tick, price, liquidity, tick spacing. " +
      "Use for \"check pool state\", \"what's the current price\", \"show pool info\" requests."
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
    .aliases(["collect", "claim-fees", "harvest"])
    .description(
      "Collect / claim / harvest uncollected V3 LP fees (agni/fluxion) for a given NFT position. " +
      "Use for \"claim fees\", \"collect rewards\", \"harvest LP earnings\" requests. " +
      "Builds an unsigned transaction. (Moe LB fees are auto-claimed when removing liquidity.)"
    )
    .requiredOption("--provider <provider>", "DEX provider: agni or fluxion")
    .requiredOption("--token-id <id>", "V3 NFT position token ID")
    .requiredOption("--recipient <address>", "address to receive collected fees")
    .requiredOption("--owner <address>", "NFT owner (the signer). Required for deterministic nonce/gas pinning.")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_buildCollectFees"].handler({
        provider: opts.provider,
        token_id: opts.tokenId,
        recipient: opts.recipient,
        owner: opts.owner,
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
    .aliases(["tick-ranges", "suggest-range"])
    .description(
      "Suggest tick ranges / price bounds for a V3 LP position. Use for " +
      "\"what range should I use\", \"help me pick a price range\", \"suggest LP bounds\" requests. " +
      "Returns wide / moderate / tight strategy presets."
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
    .aliases(["pools", "discover-pools"])
    .description(
      "Discover / find / list all available pools across Agni, Fluxion, and Merchant Moe. " +
      "Provide BOTH --token-a and --token-b for a pair query, or EITHER ONE alone for single-side " +
      "discovery (every pool involving that token, across any counterpart). " +
      "Use for \"what pools exist for X/Y\", \"find all FBTC pools\", \"list liquidity pools\" requests. " +
      "Queries factory contracts on-chain — the authoritative source."
    )
    .option("--token-a <token>", "first token symbol or address (optional; at least one of --token-a / --token-b is required)")
    .option("--token-b <token>", "second token symbol or address (optional; at least one of --token-a / --token-b is required)")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      if (!opts.tokenA && !opts.tokenB) {
        console.error(
          "\n  error: at least one of --token-a or --token-b is required.\n" +
          "  Provide both for a specific pair, or one alone for single-side discovery.\n"
        );
        process.exitCode = 1;
        return;
      }
      const result = await allTools["mantle_findPools"].handler({
        token_a: opts.tokenA,
        token_b: opts.tokenB,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        const mode = (data.mode as string) ?? "pair";
        const anchor = data.anchor_token as Record<string, unknown> | undefined;
        const tokenA = data.token_a as Record<string, unknown> | null | undefined;
        const tokenB = data.token_b as Record<string, unknown> | null | undefined;
        if (mode === "single_side") {
          const anchorSym = (anchor?.symbol as string | null | undefined) ?? (anchor?.address as string) ?? "?";
          console.log(
            `\n  ${anchorSym} — ${data.with_liquidity} pools with liquidity ` +
            `(${data.total_found} total across ${(data.scanned as Record<string, unknown> | undefined)?.counterparts_scanned ?? 0} counterparts)\n`
          );
        } else {
          const aSym = (tokenA?.symbol as string | null | undefined) ?? "?";
          const bSym = (tokenB?.symbol as string | null | undefined) ?? "?";
          console.log(
            `\n  ${aSym}/${bSym} — ` +
            `${data.with_liquidity} pools with liquidity (${data.total_found} total)\n`
          );
        }
        const pools = (data.pools ?? []) as Record<string, unknown>[];
        // In single-side mode, the most useful piece of info is WHICH
        // counterpart each pool is against. Surface it as a column.
        const columns: Array<Record<string, unknown>> = [
          { key: "provider", label: "DEX" }
        ];
        if (mode === "single_side") {
          columns.push({
            key: "token_b",
            label: "Counterpart",
            format: (v: unknown) => {
              const t = v as Record<string, unknown> | null | undefined;
              return (t?.symbol as string | null | undefined) ?? (t?.address as string | undefined)?.slice(0, 10) ?? "?";
            }
          });
        }
        columns.push(
          {
            key: "fee_tier",
            label: "Fee Tier",
            align: "right",
            format: (v: unknown) => v != null ? `${Number(v) / 10000}%` : "-"
          },
          {
            key: "bin_step",
            label: "Bin Step",
            align: "right",
            format: (v: unknown) => v != null ? String(v) : "-"
          },
          { key: "pool_address", label: "Pool Address" },
          {
            key: "has_liquidity",
            label: "Liquid",
            format: (v: unknown) => v === true ? "YES" : "NO"
          },
          {
            key: "liquidity_raw",
            label: "Liquidity",
            align: "right",
            format: (v: unknown) => {
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
            format: (v: unknown) => {
              if (v === "v3_virtual_liquidity") return "v3-L";
              if (v === "lb_active_bin_native_mixed") return "lb-bin-mixed";
              return v ? String(v) : "-";
            }
          }
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        formatTable(pools, columns as any);
      }
    });

  // ── analyze ─────────────────────────────────────────────────────────
  group
    .command("analyze")
    .aliases(["analyse", "pool-analysis", "apr"])
    .description(
      "Analyze a DEX pool — fee APR, multi-range comparison, risk scoring, investment projections. " +
      "Use for \"analyze pool\", \"estimate APR\", \"project LP returns\", \"should I provide liquidity here\" requests. " +
      "Fetches 24h volume + TVL from DexScreener to compute concentrated APR across 10 range brackets."
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
      tx_maxFeePerGas: tx?.maxFeePerGas ?? "—",
      tx_maxPriorityFeePerGas: tx?.maxPriorityFeePerGas ?? "—",
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
        tx_maxFeePerGas: "Max Fee/Gas",
        tx_maxPriorityFeePerGas: "Priority Fee",
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
