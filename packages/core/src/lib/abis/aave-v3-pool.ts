/**
 * Aave V3 Pool ABI subset — Mantle deployment.
 *
 * Pool: 0x458F293454fE0d67EC0655f3672301301DD51422
 * PoolAddressesProvider: 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f
 * ProtocolDataProvider: 0x487c5c669D9eee6057C44973207101276cf73b68
 */

export const AAVE_V3_POOL_ABI = [
  // ---- Core user-facing ----
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" }
    ],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "borrow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "referralCode", type: "uint16" },
      { name: "onBehalfOf", type: "address" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "repay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "onBehalfOf", type: "address" }
    ],
    outputs: [{ name: "", type: "uint256" }]
  },

  // ---- Configuration (packed bitmap) ----
  {
    type: "function",
    name: "getConfiguration",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ name: "configuration", type: "uint256" }]
  },

  // ---- Read helpers (useful for pre-checks) ----
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" }
    ]
  },
  {
    type: "function",
    name: "getReserveData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "configuration", type: "uint256" },
          { name: "liquidityIndex", type: "uint128" },
          { name: "currentLiquidityRate", type: "uint128" },
          { name: "variableBorrowIndex", type: "uint128" },
          { name: "currentVariableBorrowRate", type: "uint128" },
          { name: "currentStableBorrowRate", type: "uint128" },
          { name: "lastUpdateTimestamp", type: "uint40" },
          { name: "id", type: "uint16" },
          { name: "aTokenAddress", type: "address" },
          { name: "stableDebtTokenAddress", type: "address" },
          { name: "variableDebtTokenAddress", type: "address" },
          { name: "interestRateStrategyAddress", type: "address" },
          { name: "accruedToTreasury", type: "uint128" },
          { name: "unbacked", type: "uint128" },
          { name: "isolationModeTotalDebt", type: "uint128" }
        ]
      }
    ]
  }
] as const;

/**
 * Aave V3 WETH Gateway ABI subset — for native MNT supply/withdraw.
 *
 * WETHGateway: 0x9C6cCAC66b1c9AbA4855e2dD284b9e16e41E06eA
 */
export const AAVE_V3_WETH_GATEWAY_ABI = [
  {
    type: "function",
    name: "depositETH",
    stateMutability: "payable",
    inputs: [
      { name: "pool", type: "address" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "withdrawETH",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pool", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "repayETH",
    stateMutability: "payable",
    inputs: [
      { name: "pool", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "onBehalfOf", type: "address" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "borrowETH",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pool", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "referralCode", type: "uint16" }
    ],
    outputs: []
  }
] as const;
