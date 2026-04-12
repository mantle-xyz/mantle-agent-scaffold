export interface PromptDefinition {
  name: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
}

interface PromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export const prompts: PromptDefinition[] = [
  {
    name: "mantle_portfolioAudit",
    description: "Guide through a complete Mantle wallet audit: balances, allowances, and risk exposure.",
    arguments: [
      { name: "wallet_address", description: "Wallet address to audit.", required: true },
      { name: "network", description: "mainnet or sepolia (default mainnet).", required: false },
      { name: "scope", description: "full, balances_only, or allowances_only.", required: false }
    ]
  },
  {
    name: "mantle_mantleBasics",
    description: "Mantle network fundamentals for agents new to the ecosystem. Covers chain architecture, key tokens, and protocol landscape.",
    arguments: []
  },
  {
    name: "mantle_gasConfiguration",
    description: "CRITICAL: MNT gas token guidance, fee estimation, and RPC configuration for Mantle.",
    arguments: []
  }
];

function prompt(user: string, assistant: string): PromptMessage[] {
  return [
    { role: "user", content: { type: "text", text: user } },
    { role: "assistant", content: { type: "text", text: assistant } }
  ];
}

export function getPromptMessages(name: string): PromptMessage[] | null {
  switch (name) {
    case "mantle_portfolioAudit":
      return prompt(
        "How do I audit a wallet's portfolio on Mantle?",
        `# Mantle Portfolio Audit Workflow

## Step 1: Confirm Network
Call mantle_getChainInfo and mantle_getChainStatus first so chain id, RPC health, and gas context are explicit.

## Step 2: Read Native Balance
Use mantle_getBalance({ address: "<wallet>", network: "mainnet" })

## Step 3: Read ERC-20 Balances
Use mantle_getTokenBalances with curated symbols from mantle://registry/tokens.

## Step 4: Read Allowance Exposure
Use mantle_getAllowances({ owner: "<wallet>", pairs: [...] }) against known routers/spenders from mantle://registry/protocols.

## Step 5: Price and Valuation
Call mantle_getTokenPrices for each held token. Never fabricate missing prices.

## Step 6: Risk Classification
| Risk Level | Condition |
|------------|-----------|
| low | No unlimited allowances + diversified holdings |
| medium | One or more high notional allowances |
| high | Unlimited approval to core spenders or concentrated volatile holdings |

## Step 7: Final Report
Output: native balance, token balances, allowances, USD valuation totals, and explicit data gaps.

## Common Mistakes
| Mistake | Fix |
|---------|-----|
| Ignoring allowances | Always include token+spender allowance matrix |
| Fabricating USD values | Keep value null when price missing |
| Mixing networks | Normalize to mainnet/sepolia before tool calls |
`
      );
    case "mantle_mantleBasics":
      return prompt(
        "What is Mantle and how does it work?",
        `# Mantle Network Fundamentals

## Architecture
Mantle is an Ethereum L2 built with OP Stack and data availability optimizations.

## Key Facts
| Property | Value |
|----------|-------|
| Chain ID | 5000 (mainnet), 5003 (sepolia) |
| Gas Token | MNT |
| Block Time | ~2 seconds |
| Finality | L1 confirmation dependent |

## Core Tokens
| Token | Address (mainnet) | Notes |
|-------|-------------------|-------|
| WMNT | 0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8 | Wrapped MNT |
| USDC | 0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9 | |
| USDT | 0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE | Bridged Tether — active on DEXes |
| USDT0 | 0x779Ded0c9e1022225f8E0630b35a9b54bE713736 | LayerZero OFT Tether — active on DEXes AND Aave V3 |

> **USDT vs USDT0**: Mantle has two official USDT variants. Both have deep DEX liquidity. Only USDT0 is supported on Aave V3. A USDT/USDT0 pool exists on Merchant Moe (bin_step=1) for direct conversion.

## DeFi Landscape
| Protocol | Category | Status |
|----------|----------|--------|
| Agni | DEX | enabled |
| Merchant Moe | DEX | enabled |
| Aave v3 | lending | enabled |
| Ondo | RWA | planned post-v1 |

## Getting Started
1. mantle_getChainInfo({ network: "mainnet" })
2. mantle_getChainStatus({ network: "mainnet" })
3. Read mantle://registry/tokens and mantle://registry/protocols
`
      );
    case "mantle_gasConfiguration":
      return prompt(
        "How does gas work on Mantle?",
        `# Mantle Gas Configuration

## CRITICAL: Gas Token is MNT, Not ETH
All gas estimates and native balances are denominated in MNT.

## Gas Costs (Very Cheap)
| Operation | Typical Gas | Approx MNT Cost |
|-----------|-------------|------------------|
| MNT transfer | 21,000 | ~0.0002 |
| ERC-20 transfer | 65,000 | ~0.0006 |
| DEX swap | 180,000 | ~0.0016 |
| Contract deployment | 1M-3M | ~0.01-0.03 |

## Checking Live Gas
Use mantle_getChainStatus({ network: "mainnet" }) and report gas_price_gwei + block_number.

## RPC Endpoints
| Network | URL |
|---------|-----|
| Mainnet | https://rpc.mantle.xyz |
| Sepolia | https://rpc.sepolia.mantle.xyz |

## Common Mistakes
| Mistake | Fix |
|---------|-----|
| Assuming ETH is gas token | Use MNT for all fee math |
| Reusing Ethereum gas assumptions | Recalculate on Mantle chain status |
| Ignoring RPC fallback | Configure dedicated RPC + fallback endpoint |
`
      );
    default:
      return null;
  }
}
