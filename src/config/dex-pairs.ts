/**
 * Known DEX trading pairs on Mantle with their pool parameters.
 *
 * Agents should use this registry to auto-resolve pool parameters
 * (bin_step for Merchant Moe, fee_tier for V3 DEXes) instead of
 * guessing or asking the user.
 *
 * Sources:
 * - GeckoTerminal: https://www.geckoterminal.com/mantle/
 * - Merchant Moe docs: https://docs.merchantmoe.com/resources/contracts
 * - Agni Finance: https://agni.finance
 */

import type { Network } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MoePair {
  provider: "merchant_moe";
  tokenA: string;
  tokenB: string;
  tokenAAddress: string;
  tokenBAddress: string;
  pool: string;
  /** Bin step in basis points (1 = 0.01%). Stablecoin pairs use 1, volatile use 15-25+. */
  binStep: number;
  /** Liquidity Book version. */
  version: number;
}

export interface V3Pair {
  provider: "agni" | "fluxion";
  tokenA: string;
  tokenB: string;
  tokenAAddress: string;
  tokenBAddress: string;
  pool: string;
  /** Fee tier in hundredths of basis points (500 = 0.05%, 3000 = 0.3%, 10000 = 1%). */
  feeTier: number;
}

export type DexPair = MoePair | V3Pair;

// ---------------------------------------------------------------------------
// Token address constants (Mantle mainnet)
// ---------------------------------------------------------------------------

const TOKENS = {
  WMNT: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
  USDC: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
  USDT0: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
  USDe: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
  WETH: "0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111",
  mETH: "0xcDA86A272531e8640cD7F1a92c01839911B90bb0",
  cmETH: "0xE6829d9a7eE3040e1276Fa75293Bde931859e8C0",
  FBTC: "0xC96dE26018A54D51c097160568752c4E3BD6C364",
  sUSDe: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2",
  MOE: "0x4515A45337F461A11Ff0FE8aBF3c606AE5dC00c9"
} as const;

// ---------------------------------------------------------------------------
// Merchant Moe Liquidity Book pairs
// ---------------------------------------------------------------------------

const MOE_PAIRS: MoePair[] = [
  // ---- Stablecoin pairs (bin_step = 1) ----
  {
    provider: "merchant_moe",
    tokenA: "USDC", tokenB: "USDT0",
    tokenAAddress: TOKENS.USDC, tokenBAddress: TOKENS.USDT0,
    pool: "0x48c1a89af1102cad358549e9bb16ae5f96cddfec",
    binStep: 1, version: 2
  },
  {
    provider: "merchant_moe",
    tokenA: "USDe", tokenB: "USDT0",
    tokenAAddress: TOKENS.USDe, tokenBAddress: TOKENS.USDT0,
    pool: "0x7ccd8a769d466340fff36c6e10ffa8cf9077d988",
    binStep: 1, version: 2
  },
  {
    provider: "merchant_moe",
    tokenA: "USDC", tokenB: "USDe",
    tokenAAddress: TOKENS.USDC, tokenBAddress: TOKENS.USDe,
    pool: "0xd55639c3312467adafb347614806f1d30525c0c8",
    binStep: 1, version: 2
  },

  // ---- WMNT pairs (bin_step = 15-25) ----
  {
    provider: "merchant_moe",
    tokenA: "WMNT", tokenB: "USDT0",
    tokenAAddress: TOKENS.WMNT, tokenBAddress: TOKENS.USDT0,
    pool: "0xf6c9020c9e915808481757779edb53daceae2415",
    binStep: 20, version: 2
  },
  {
    provider: "merchant_moe",
    tokenA: "WMNT", tokenB: "USDe",
    tokenAAddress: TOKENS.WMNT, tokenBAddress: TOKENS.USDe,
    pool: "0x5d54d430d1fd9425976147318e6080479bffc16d",
    binStep: 20, version: 2
  },
  {
    provider: "merchant_moe",
    tokenA: "WMNT", tokenB: "USDC",
    tokenAAddress: TOKENS.WMNT, tokenBAddress: TOKENS.USDC,
    pool: "0x8e3a13418743ab1a98434551937ea687e451b589",
    binStep: 20, version: 2
  },

  // ---- ETH derivative pairs ----
  {
    provider: "merchant_moe",
    tokenA: "mETH", tokenB: "WETH",
    tokenAAddress: TOKENS.mETH, tokenBAddress: TOKENS.WETH,
    pool: "0x86e3a987187fed135d6d9c114f1857d8144f01e1",
    binStep: 5, version: 2
  },
  {
    provider: "merchant_moe",
    tokenA: "cmETH", tokenB: "mETH",
    tokenAAddress: TOKENS.cmETH, tokenBAddress: TOKENS.mETH,
    pool: "0x3d887ce4988fb46aec6e0027171f65db3526e5f1",
    binStep: 5, version: 2
  }
];

// ---------------------------------------------------------------------------
// Agni Finance V3 pairs
// ---------------------------------------------------------------------------

const AGNI_PAIRS: V3Pair[] = [
  {
    provider: "agni",
    tokenA: "WETH", tokenB: "WMNT",
    tokenAAddress: TOKENS.WETH, tokenBAddress: TOKENS.WMNT,
    pool: "0x54169896d28dec0ffabe3b16f90f71323774949f",
    feeTier: 500 // 0.05%
  },
  {
    provider: "agni",
    tokenA: "USDC", tokenB: "WMNT",
    tokenAAddress: TOKENS.USDC, tokenBAddress: TOKENS.WMNT,
    pool: "0x8e2c009e45420d2b36bc15315f9de8ceca2cc724",
    feeTier: 10000 // 1%
  },
  {
    provider: "agni",
    tokenA: "mETH", tokenB: "WETH",
    tokenAAddress: TOKENS.mETH, tokenBAddress: TOKENS.WETH,
    pool: "0x4f9e3683a523b66da89d82bba0a9caa1c3243df4",
    feeTier: 500 // 0.05%
  },
  {
    provider: "agni",
    tokenA: "USDT0", tokenB: "WMNT",
    tokenAAddress: TOKENS.USDT0, tokenBAddress: TOKENS.WMNT,
    pool: "0x07c41050a6a18040f1530d88d1d1b5e9261caf73",
    feeTier: 500 // 0.05%
  }
];

// ---------------------------------------------------------------------------
// Fluxion V3 pairs (limited data — recently launched Dec 2025)
// ---------------------------------------------------------------------------

const FLUXION_PAIRS: V3Pair[] = [
  {
    provider: "fluxion",
    tokenA: "WMNT", tokenB: "USDC",
    tokenAAddress: TOKENS.WMNT, tokenBAddress: TOKENS.USDC,
    pool: "0x0000000000000000000000000000000000000000", // TODO: verify on-chain
    feeTier: 3000 // 0.3% — default V3 tier
  },
  {
    provider: "fluxion",
    tokenA: "WMNT", tokenB: "USDT0",
    tokenAAddress: TOKENS.WMNT, tokenBAddress: TOKENS.USDT0,
    pool: "0x0000000000000000000000000000000000000000", // TODO: verify on-chain
    feeTier: 3000
  }
];

// ---------------------------------------------------------------------------
// Registry (mainnet only for now)
// ---------------------------------------------------------------------------

const ALL_PAIRS: DexPair[] = [...MOE_PAIRS, ...AGNI_PAIRS, ...FLUXION_PAIRS];

type Provider = "merchant_moe" | "agni" | "fluxion";

/**
 * Find a known trading pair by provider and token symbols.
 * Matches in either direction (A/B or B/A).
 */
export function findPair(
  provider: Provider,
  tokenA: string,
  tokenB: string,
  _network?: Network
): DexPair | null {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  return (
    ALL_PAIRS.find(
      (p) =>
        p.provider === provider &&
        ((p.tokenA.toLowerCase() === a && p.tokenB.toLowerCase() === b) ||
          (p.tokenA.toLowerCase() === b && p.tokenB.toLowerCase() === a))
    ) ?? null
  );
}

/**
 * Find a known trading pair by provider and token addresses.
 * Matches in either direction.
 */
export function findPairByAddress(
  provider: Provider,
  addressA: string,
  addressB: string,
  _network?: Network
): DexPair | null {
  const a = addressA.toLowerCase();
  const b = addressB.toLowerCase();
  return (
    ALL_PAIRS.find(
      (p) =>
        p.provider === provider &&
        ((p.tokenAAddress.toLowerCase() === a &&
          p.tokenBAddress.toLowerCase() === b) ||
          (p.tokenAAddress.toLowerCase() === b &&
            p.tokenBAddress.toLowerCase() === a))
    ) ?? null
  );
}

/**
 * List all known pairs for a provider.
 */
export function listPairs(provider: Provider): DexPair[] {
  return ALL_PAIRS.filter((p) => p.provider === provider);
}

/**
 * List all known pairs across all providers.
 */
export function listAllPairs(): DexPair[] {
  return ALL_PAIRS;
}
