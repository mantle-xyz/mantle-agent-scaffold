import { describe, expect, it } from "vitest";
import { allTools } from "../src/tools/index.js";

describe("server wiring", () => {
  it("registers all v0.2 tools", () => {
    const names = Object.values(allTools).map((tool) => tool.name).sort();
    expect(names).toEqual([
      "mantle_buildAaveBorrow",
      "mantle_buildAaveRepay",
      "mantle_buildAaveSupply",
      "mantle_buildAaveWithdraw",
      "mantle_buildAddLiquidity",
      "mantle_buildApprove",
      "mantle_buildRemoveLiquidity",
      "mantle_buildSwap",
      "mantle_buildUnwrapMnt",
      "mantle_buildWrapMnt",
      "mantle_checkRpcHealth",
      "mantle_getAllowances",
      "mantle_getBalance",
      "mantle_getChainInfo",
      "mantle_getChainStatus",
      "mantle_getLendingMarkets",
      "mantle_getPoolLiquidity",
      "mantle_getPoolOpportunities",
      "mantle_getProtocolTvl",
      "mantle_getSwapPairs",
      "mantle_getSwapQuote",
      "mantle_getTokenBalances",
      "mantle_getTokenInfo",
      "mantle_getTokenPrices",
      "mantle_probeEndpoint",
      "mantle_queryIndexerSql",
      "mantle_querySubgraph",
      "mantle_resolveAddress",
      "mantle_resolveToken",
      "mantle_validateAddress"
    ]);
  });

  it("indexes tools by MCP tool name for O(1) dispatch", () => {
    const keys = Object.keys(allTools).sort();
    const names = Object.values(allTools).map((tool) => tool.name).sort();
    expect(keys).toEqual(names);
  });
});
