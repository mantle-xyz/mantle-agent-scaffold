/**
 * WMNT (Wrapped Mantle) ABI — WETH9-style contract.
 *
 * Contract: 0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8
 * Standard OpenZeppelin ERC20 + deposit()/withdraw().
 */
export const WMNT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: []
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: []
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" }
    ],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "event",
    name: "Deposit",
    inputs: [
      { name: "dst", type: "address", indexed: true },
      { name: "wad", type: "uint256", indexed: false }
    ]
  },
  {
    type: "event",
    name: "Withdrawal",
    inputs: [
      { name: "src", type: "address", indexed: true },
      { name: "wad", type: "uint256", indexed: false }
    ]
  }
] as const;

export const WMNT_ADDRESS = "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8" as const;
