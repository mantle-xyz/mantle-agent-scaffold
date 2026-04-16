/**
 * Merchant Moe Liquidity Book V2.2 Router ABI subset.
 *
 * LB Router V2.2: 0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a
 * MoeRouter:       0xeaEE7EE68874218c3558b40063c42B82D3E7232a
 *
 * The LB Router supports both swap and liquidity operations.
 * MoeRouter is a simpler V1-style router for swap-only.
 */

// ---------------------------------------------------------------------------
// LB Router V2.2 — swap + liquidity
// ---------------------------------------------------------------------------

export const LB_ROUTER_ABI = [
  // ---- Swap ----
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      {
        name: "path",
        type: "tuple",
        components: [
          { name: "pairBinSteps", type: "uint256[]" },
          { name: "versions", type: "uint8[]" },
          { name: "tokenPath", type: "address[]" }
        ]
      },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [{ name: "amountOut", type: "uint256" }]
  },
  {
    type: "function",
    name: "swapExactTokensForMNT",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMinMNT", type: "uint256" },
      {
        name: "path",
        type: "tuple",
        components: [
          { name: "pairBinSteps", type: "uint256[]" },
          { name: "versions", type: "uint8[]" },
          { name: "tokenPath", type: "address[]" }
        ]
      },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [{ name: "amountOut", type: "uint256" }]
  },
  {
    type: "function",
    name: "swapExactMNTForTokens",
    stateMutability: "payable",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      {
        name: "path",
        type: "tuple",
        components: [
          { name: "pairBinSteps", type: "uint256[]" },
          { name: "versions", type: "uint8[]" },
          { name: "tokenPath", type: "address[]" }
        ]
      },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [{ name: "amountOut", type: "uint256" }]
  },

  // ---- Liquidity ----
  {
    type: "function",
    name: "addLiquidity",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "liquidityParameters",
        type: "tuple",
        components: [
          { name: "tokenX", type: "address" },
          { name: "tokenY", type: "address" },
          { name: "binStep", type: "uint256" },
          { name: "amountX", type: "uint256" },
          { name: "amountY", type: "uint256" },
          { name: "amountXMin", type: "uint256" },
          { name: "amountYMin", type: "uint256" },
          { name: "activeIdDesired", type: "uint256" },
          { name: "idSlippage", type: "uint256" },
          { name: "deltaIds", type: "int256[]" },
          { name: "distributionX", type: "uint256[]" },
          { name: "distributionY", type: "uint256[]" },
          { name: "to", type: "address" },
          { name: "refundTo", type: "address" },
          { name: "deadline", type: "uint256" }
        ]
      }
    ],
    outputs: [
      { name: "amountXAdded", type: "uint256" },
      { name: "amountYAdded", type: "uint256" },
      { name: "amountXLeft", type: "uint256" },
      { name: "amountYLeft", type: "uint256" },
      { name: "depositIds", type: "uint256[]" },
      { name: "liquidityMinted", type: "uint256[]" }
    ]
  },
  {
    type: "function",
    name: "addLiquidityMNT",
    stateMutability: "payable",
    inputs: [
      {
        name: "liquidityParameters",
        type: "tuple",
        components: [
          { name: "tokenX", type: "address" },
          { name: "tokenY", type: "address" },
          { name: "binStep", type: "uint256" },
          { name: "amountX", type: "uint256" },
          { name: "amountY", type: "uint256" },
          { name: "amountXMin", type: "uint256" },
          { name: "amountYMin", type: "uint256" },
          { name: "activeIdDesired", type: "uint256" },
          { name: "idSlippage", type: "uint256" },
          { name: "deltaIds", type: "int256[]" },
          { name: "distributionX", type: "uint256[]" },
          { name: "distributionY", type: "uint256[]" },
          { name: "to", type: "address" },
          { name: "refundTo", type: "address" },
          { name: "deadline", type: "uint256" }
        ]
      }
    ],
    outputs: [
      { name: "amountXAdded", type: "uint256" },
      { name: "amountYAdded", type: "uint256" },
      { name: "amountXLeft", type: "uint256" },
      { name: "amountYLeft", type: "uint256" },
      { name: "depositIds", type: "uint256[]" },
      { name: "liquidityMinted", type: "uint256[]" }
    ]
  },
  {
    type: "function",
    name: "removeLiquidity",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenX", type: "address" },
      { name: "tokenY", type: "address" },
      { name: "binStep", type: "uint16" },
      { name: "amountXMin", type: "uint256" },
      { name: "amountYMin", type: "uint256" },
      { name: "ids", type: "uint256[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [
      { name: "amountX", type: "uint256" },
      { name: "amountY", type: "uint256" }
    ]
  },
  {
    type: "function",
    name: "removeLiquidityMNT",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "binStep", type: "uint16" },
      { name: "amountTokenMin", type: "uint256" },
      { name: "amountMNTMin", type: "uint256" },
      { name: "ids", type: "uint256[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [
      { name: "amountToken", type: "uint256" },
      { name: "amountMNT", type: "uint256" }
    ]
  }
] as const;

// ---------------------------------------------------------------------------
// MoeRouter — V1-style swap only (simpler interface)
// ---------------------------------------------------------------------------

export const MOE_ROUTER_ABI = [
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }]
  },
  {
    type: "function",
    name: "swapExactMNTForTokens",
    stateMutability: "payable",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }]
  },
  {
    type: "function",
    name: "swapExactTokensForMNT",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }]
  },
  {
    type: "function",
    name: "getAmountsOut",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" }
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }]
  }
] as const;

// ---------------------------------------------------------------------------
// LB Pair — on-chain pool state queries
// ---------------------------------------------------------------------------

export const LB_PAIR_ABI = [
  {
    type: "function",
    name: "getActiveId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "activeId", type: "uint24" }]
  },
  {
    type: "function",
    name: "getBin",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint24" }],
    outputs: [
      { name: "binReserveX", type: "uint128" },
      { name: "binReserveY", type: "uint128" }
    ]
  },
  {
    type: "function",
    name: "getTokenX",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  },
  {
    type: "function",
    name: "getTokenY",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  },
  {
    type: "function",
    name: "getBinStep",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }]
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" }
    ],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  // ---- LBToken approval (ERC-1155-ish, but LB uses approveForAll) ----
  // NOTE: LBToken's spec names the setter `approveForAll` (not the ERC-1155
  // standard `setApprovalForAll`). It's a single-operator per-owner flag
  // that the LB Router requires in order to burn the user's LB shares
  // during `removeLiquidity`.
  {
    type: "function",
    name: "approveForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "approved", type: "bool" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "isApprovedForAll",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" }
    ],
    outputs: [{ name: "", type: "bool" }]
  }
] as const;

// ---------------------------------------------------------------------------
// LB Factory — pair address resolution
// ---------------------------------------------------------------------------

export const LB_FACTORY_ABI = [
  {
    type: "function",
    name: "getLBPairInformation",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "binStep", type: "uint256" }
    ],
    outputs: [
      {
        name: "info",
        type: "tuple",
        components: [
          { name: "binStep", type: "uint16" },
          { name: "LBPair", type: "address" },
          { name: "createdByOwner", type: "bool" },
          { name: "ignoredForRouting", type: "bool" }
        ]
      }
    ]
  }
] as const;

// ---------------------------------------------------------------------------
// LB Quoter V2.2 — on-chain swap quoting with automatic route discovery
// LB Quoter V2.2: 0x501b8AFd35df20f531fF45F6f695793AC3316c85
// ---------------------------------------------------------------------------

export const LB_QUOTER_ABI = [
  {
    type: "function" as const,
    name: "findBestPathFromAmountIn" as const,
    stateMutability: "view" as const,
    inputs: [
      { name: "route", type: "address[]" as const },
      { name: "amountIn", type: "uint128" as const }
    ],
    outputs: [
      {
        name: "quote",
        type: "tuple" as const,
        components: [
          { name: "route", type: "address[]" as const },
          { name: "pairs", type: "address[]" as const },
          { name: "binSteps", type: "uint256[]" as const },
          { name: "versions", type: "uint256[]" as const },
          { name: "amounts", type: "uint128[]" as const },
          { name: "virtualAmountsWithoutSlippage", type: "uint128[]" as const },
          { name: "fees", type: "uint128[]" as const }
        ]
      }
    ]
  }
] as const;
