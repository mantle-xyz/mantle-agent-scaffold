/**
 * DeFi Lending Read Tools — on-chain reads for Aave V3 user positions on Mantle.
 *
 * Reads user account data (health factor, collateral, debt) and per-reserve
 * aToken / variableDebtToken / stableDebtToken balances.
 *
 * Uses multicall to batch all balance reads into a single RPC round-trip.
 * Reads stableDebtToken addresses dynamically from getReserveData to avoid
 * hardcoding addresses that the aave-address-book does not publish for Mantle.
 *
 * All tools are pure reads — no state mutation, no private keys.
 */

import { formatUnits, getAddress, isAddress } from "viem";
import { MantleMcpError } from "../errors.js";
import { getPublicClient } from "../lib/clients.js";
import { normalizeNetwork } from "../lib/network.js";
import { AAVE_V3_POOL_ABI } from "../lib/abis/aave-v3-pool.js";
import { ERC20_ABI } from "../lib/erc20.js";
import { AAVE_V3_MANTLE_RESERVES } from "../config/aave-reserves.js";
import { MANTLE_PROTOCOLS } from "../config/protocols.js";
import type { Tool } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const nowUtc = () => new Date().toISOString();

function requireAddress(input: unknown, fieldName: string): string {
  if (typeof input !== "string" || !isAddress(input, { strict: false })) {
    throw new MantleMcpError(
      "INVALID_ADDRESS",
      `${fieldName} must be a valid address.`,
      "Provide an EIP-55 address string.",
      { field: fieldName, value: input ?? null }
    );
  }
  return getAddress(input);
}

// ---------------------------------------------------------------------------
// getAavePositions — aggregate account data + per-reserve balances
// ---------------------------------------------------------------------------

export interface AavePositionDeps {
  getClient: (network: "mainnet" | "sepolia") => any;
  now: () => string;
}

const defaultDeps: AavePositionDeps = {
  getClient: getPublicClient,
  now: nowUtc
};

function withDeps(overrides?: Partial<AavePositionDeps>): AavePositionDeps {
  return { ...defaultDeps, ...overrides };
}

export async function getAavePositions(
  args: Record<string, unknown>,
  deps?: Partial<AavePositionDeps>
): Promise<unknown> {
  const resolvedDeps = withDeps(deps);
  const { network } = normalizeNetwork(args);
  const user = requireAddress(args.user, "user");

  const protocolConfig = MANTLE_PROTOCOLS[network]?.aave_v3;
  if (!protocolConfig) {
    throw new MantleMcpError(
      "UNSUPPORTED_NETWORK",
      `Aave V3 is not configured for ${network}.`,
      "Use network=mainnet.",
      { network }
    );
  }

  const poolAddress = protocolConfig.contracts.pool as `0x${string}`;
  const client = resolvedDeps.getClient(network);
  const reserves = AAVE_V3_MANTLE_RESERVES;

  // 1. Read aggregate account data from the Pool contract
  const accountData = (await client.readContract({
    address: poolAddress,
    abi: AAVE_V3_POOL_ABI,
    functionName: "getUserAccountData",
    args: [user as `0x${string}`]
  })) as [bigint, bigint, bigint, bigint, bigint, bigint];

  const [
    totalCollateralBase,
    totalDebtBase,
    availableBorrowsBase,
    currentLiquidationThreshold,
    ltv,
    healthFactor
  ] = accountData;

  // Aave base currency has 8 decimals (USD with 8 dp)
  const BASE_DECIMALS = 8;

  // 2. Read stableDebtToken addresses dynamically from getReserveData.
  //    This avoids hardcoding addresses the aave-address-book does not publish
  //    for Mantle, and resolves the read/write asymmetry with stable borrows.
  const reserveDataCalls = reserves.map((reserve) => ({
    address: poolAddress,
    abi: AAVE_V3_POOL_ABI,
    functionName: "getReserveData" as const,
    args: [reserve.underlying as `0x${string}`]
  }));

  const reserveDataResults = await client.multicall({ contracts: reserveDataCalls });

  // Extract stableDebtToken addresses from on-chain data
  const stableDebtTokens: Array<`0x${string}` | null> = reserveDataResults.map(
    (r: { status: string; result?: any }) => {
      if (r.status !== "success" || !r.result) return null;
      // getReserveData returns a tuple; index 9 is stableDebtTokenAddress
      return (r.result.stableDebtTokenAddress ?? r.result[9] ?? null) as `0x${string}` | null;
    }
  );

  // 3. Batch ALL balance reads into a single multicall:
  //    per reserve: aToken + variableDebtToken + stableDebtToken = 3 calls
  const balanceCalls = reserves.flatMap((reserve, idx) => {
    const calls = [
      {
        address: reserve.aToken as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf" as const,
        args: [user as `0x${string}`]
      },
      {
        address: reserve.variableDebtToken as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf" as const,
        args: [user as `0x${string}`]
      }
    ];
    const stableAddr = stableDebtTokens[idx];
    if (stableAddr && stableAddr !== "0x0000000000000000000000000000000000000000") {
      calls.push({
        address: stableAddr,
        abi: ERC20_ABI,
        functionName: "balanceOf" as const,
        args: [user as `0x${string}`]
      });
    }
    return calls;
  });

  const balanceResults = await client.multicall({ contracts: balanceCalls });

  // 4. Parse results
  const reserveErrors: Array<{
    reserve: string;
    token_type: string;
    error: string;
  }> = [];

  const positions: Array<{
    symbol: string;
    underlying: string;
    decimals: number;
    a_token: string;
    supplied_raw: string;
    supplied: string;
    variable_debt_token: string;
    variable_debt_raw: string;
    variable_debt: string;
    stable_debt_token: string | null;
    stable_debt_raw: string;
    stable_debt: string;
    total_debt_raw: string;
    total_debt: string;
    isolation_mode: boolean;
  }> = [];

  let callIdx = 0;
  for (let i = 0; i < reserves.length; i++) {
    const reserve = reserves[i];
    const hasStable = stableDebtTokens[i] != null &&
      stableDebtTokens[i] !== "0x0000000000000000000000000000000000000000";

    // aToken balance
    const supplyResult = balanceResults[callIdx++];
    const supplyFailed = supplyResult.status !== "success";
    const suppliedRaw = supplyResult.status === "success"
      ? (supplyResult.result as bigint) : 0n;

    // variableDebtToken balance
    const varDebtResult = balanceResults[callIdx++];
    const varDebtFailed = varDebtResult.status !== "success";
    const varDebtRaw = varDebtResult.status === "success"
      ? (varDebtResult.result as bigint) : 0n;

    // stableDebtToken balance (if applicable)
    let stableDebtRaw = 0n;
    let stableDebtFailed = false;
    if (hasStable) {
      const stableResult = balanceResults[callIdx++];
      stableDebtFailed = stableResult.status !== "success";
      stableDebtRaw = stableResult.status === "success"
        ? (stableResult.result as bigint) : 0n;
    }

    // Track per-reserve read failures
    if (supplyFailed) {
      reserveErrors.push({
        reserve: reserve.symbol,
        token_type: "aToken",
        error: "multicall read failed"
      });
    }
    if (varDebtFailed) {
      reserveErrors.push({
        reserve: reserve.symbol,
        token_type: "variableDebtToken",
        error: "multicall read failed"
      });
    }
    if (stableDebtFailed) {
      reserveErrors.push({
        reserve: reserve.symbol,
        token_type: "stableDebtToken",
        error: "multicall read failed"
      });
    }

    const totalDebtRaw = varDebtRaw + stableDebtRaw;

    // Skip reserves with zero supply and zero debt (and no read errors)
    if (
      suppliedRaw === 0n && totalDebtRaw === 0n &&
      !supplyFailed && !varDebtFailed && !stableDebtFailed
    ) continue;

    positions.push({
      symbol: reserve.symbol,
      underlying: reserve.underlying,
      decimals: reserve.decimals,
      a_token: reserve.aToken,
      supplied_raw: suppliedRaw.toString(),
      supplied: formatUnits(suppliedRaw, reserve.decimals),
      variable_debt_token: reserve.variableDebtToken,
      variable_debt_raw: varDebtRaw.toString(),
      variable_debt: formatUnits(varDebtRaw, reserve.decimals),
      stable_debt_token: hasStable ? stableDebtTokens[i] : null,
      stable_debt_raw: stableDebtRaw.toString(),
      stable_debt: formatUnits(stableDebtRaw, reserve.decimals),
      total_debt_raw: totalDebtRaw.toString(),
      total_debt: formatUnits(totalDebtRaw, reserve.decimals),
      isolation_mode: reserve.isolationMode
    });
  }

  // Health factor: 1e18 scale. type(uint256).max === no debt (Aave sentinel)
  const MAX_UINT256 = 2n ** 256n - 1n;
  const healthFactorNum =
    healthFactor === MAX_UINT256
      ? null // no debt → infinite
      : Number(formatUnits(healthFactor, 18));

  const partial = reserveErrors.length > 0;

  // F-04: Detect possible missing reserves by comparing aggregate vs per-reserve sums.
  // getUserAccountData totals include ALL reserves (even ones not in our hardcoded list).
  // If the sums diverge significantly, flag it.
  const totalCollateralUsd = Number(formatUnits(totalCollateralBase, BASE_DECIMALS));
  const totalDebtUsd = Number(formatUnits(totalDebtBase, BASE_DECIMALS));
  // We can't easily sum per-reserve USD without prices, but we can flag when
  // getUserAccountData shows debt > 0 but we found zero per-reserve debt positions.
  const perReserveDebtCount = positions.filter((p) => p.total_debt_raw !== "0").length;
  const possibleMissingReserves =
    (totalDebtUsd > 0.01 && perReserveDebtCount === 0) ||
    (totalCollateralUsd > 0.01 && positions.filter((p) => p.supplied_raw !== "0").length === 0);

  return {
    user,
    network,
    protocol: "aave_v3",
    account: {
      total_collateral_usd: formatUnits(totalCollateralBase, BASE_DECIMALS),
      total_debt_usd: formatUnits(totalDebtBase, BASE_DECIMALS),
      available_borrows_usd: formatUnits(availableBorrowsBase, BASE_DECIMALS),
      current_liquidation_threshold_bps: Number(currentLiquidationThreshold),
      ltv_bps: Number(ltv),
      health_factor: healthFactorNum,
      health_factor_raw: healthFactor.toString(),
      health_status:
        healthFactorNum === null
          ? "no_debt"
          : healthFactorNum > 2
            ? "safe"
            : healthFactorNum > 1.1
              ? "moderate"
              : healthFactorNum > 1
                ? "at_risk"
                : "liquidatable"
    },
    positions,
    total_supplied_positions: positions.filter((p) => p.supplied_raw !== "0").length,
    total_borrowed_positions: positions.filter((p) => p.total_debt_raw !== "0").length,
    known_reserves: reserves.length,
    possible_missing_reserves: possibleMissingReserves ? true : undefined,
    possible_missing_reserves_note: possibleMissingReserves
      ? "Aggregate account data shows collateral/debt not accounted for by known reserves. " +
        "Aave governance may have added new reserves not yet in this tool's registry."
      : undefined,
    partial,
    reserve_errors: reserveErrors.length > 0 ? reserveErrors : undefined,
    queried_at_utc: resolvedDeps.now()
  };
}

// ---------------------------------------------------------------------------
// Tool export
// ---------------------------------------------------------------------------

export const defiLendingReadTools: Record<string, Tool> = {
  mantle_getAavePositions: {
    name: "mantle_getAavePositions",
    description:
      "Read a wallet's Aave V3 positions on Mantle: supplied collateral, borrowed debt " +
      "(both variable and stable), health factor, liquidation threshold, and per-reserve " +
      "aToken/debtToken balances.\n\n" +
      "Returns aggregate account data (total collateral/debt in USD, health factor with " +
      "status classification) plus per-reserve breakdowns for all reserves with non-zero " +
      "supply or debt. Reads stableDebtToken addresses dynamically from on-chain data.\n\n" +
      "Uses multicall to batch all balance reads into minimal RPC round-trips.\n\n" +
      "Use this tool for:\n" +
      "- Portfolio valuation (aToken balances are positive assets, debtTokens are liabilities)\n" +
      "- Liquidation risk assessment (health_factor < 1 = liquidatable)\n" +
      "- Pre-transaction safety checks (available borrows, current LTV)\n\n" +
      "Examples:\n" +
      "- All positions: user='<wallet_address>'\n" +
      "- Specific network: user='<wallet_address>', network='mainnet'",
    inputSchema: {
      type: "object",
      properties: {
        user: {
          type: "string",
          description: "Wallet address to query Aave V3 positions for."
        },
        network: {
          type: "string",
          enum: ["mainnet", "sepolia"],
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["user"]
    },
    handler: getAavePositions
  }
};
