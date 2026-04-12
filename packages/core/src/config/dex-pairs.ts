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
  /**
   * LB Router path version enum. This is the value passed in the `versions[]`
   * array when calling `swapExactTokensForTokens`.
   *   0 = V1 (classic AMM), 1 = V2, 2 = V2.1, 3 = V2.2
   * Defaults to 0 (V1) if omitted — V1 routing works for all Moe pools.
   */
  routerVersion?: number;
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

export const TOKENS = {
  WMNT: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
  USDC: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
  USDT0: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
  USDe: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
  WETH: "0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111",
  mETH: "0xcDA86A272531e8640cD7F1a92c01839911B90bb0",
  cmETH: "0xE6829d9a7eE3040e1276Fa75293Bde931859e8fA",
  FBTC: "0xC96dE26018A54D51c097160568752c4E3BD6C364",
  sUSDe: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2",
  MOE: "0x4515A45337F461A11Ff0FE8aBF3c606AE5dC00c9",
  USDT: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
  BSB: "0xe5c330ADdf7aa9C7838dA836436142c56a15aa95",
  ELSA: "0x29cC30f9D113B356Ce408667aa6433589CeCBDcA",
  VOOI: "0xd81a4aDea9932a6BDba0bDBc8C5Fd4C78e5A09f1"
} as const;

// ---------------------------------------------------------------------------
// Merchant Moe Liquidity Book pairs
// ---------------------------------------------------------------------------

const MOE_PAIRS: MoePair[] = [
  // ---- USDT0 stablecoin pairs (bin_step = 1, LB V2.2 pools) ----
  {
    provider: "merchant_moe",
    tokenA: "USDC", tokenB: "USDT0",
    tokenAAddress: TOKENS.USDC, tokenBAddress: TOKENS.USDT0,
    pool: "0x368B148052A1A775Dbe70e56d04474e54c694CAC",
    binStep: 1, version: 2, routerVersion: 3
  },
  {
    provider: "merchant_moe",
    tokenA: "USDe", tokenB: "USDT0",
    tokenAAddress: TOKENS.USDe, tokenBAddress: TOKENS.USDT0,
    pool: "0x2093A6fd094124a55F180dceA5033c3BF481100e",
    binStep: 1, version: 2, routerVersion: 3
  },
  {
    provider: "merchant_moe",
    tokenA: "USDC", tokenB: "USDe",
    tokenAAddress: TOKENS.USDC, tokenBAddress: TOKENS.USDe,
    pool: "0x7e78B65d0525339dF5F4aA22b82d9e97584Da8FC",
    binStep: 1, version: 2, routerVersion: 3
  },

  // ---- USDT stablecoin pairs (LB V2.2 pools) ----
  // NOTE: Mantle has two official USDT assets — USDT (bridged Tether) and
  // USDT0 (LayerZero OFT). Both have active DEX liquidity; only USDT0 is
  // supported on Aave V3.
  {
    provider: "merchant_moe",
    tokenA: "USDC", tokenB: "USDT",
    tokenAAddress: TOKENS.USDC, tokenBAddress: TOKENS.USDT,
    pool: "0x48c1a89af1102cad358549e9bb16ae5f96cddfec",
    binStep: 1, version: 2, routerVersion: 3
  },
  {
    provider: "merchant_moe",
    tokenA: "USDe", tokenB: "USDT",
    tokenAAddress: TOKENS.USDe, tokenBAddress: TOKENS.USDT,
    pool: "0x7ccd8a769d466340fff36c6e10ffa8cf9077d988",
    binStep: 1, version: 2, routerVersion: 3
  },
  {
    provider: "merchant_moe",
    tokenA: "USDT", tokenB: "USDT0",
    tokenAAddress: TOKENS.USDT, tokenBAddress: TOKENS.USDT0,
    pool: "0xfc9D88653E2988B0e6525f1F521c974a25c88566",
    binStep: 1, version: 2, routerVersion: 3
  },

  // ---- WMNT pairs (V2.2 pools) ----
  {
    provider: "merchant_moe",
    tokenA: "WMNT", tokenB: "USDT0",
    tokenAAddress: TOKENS.WMNT, tokenBAddress: TOKENS.USDT0,
    pool: "0xC0729cDE19741dE280b230D650F0fDad2aD79D09",
    binStep: 25, version: 2
  },
  {
    provider: "merchant_moe",
    tokenA: "WMNT", tokenB: "USDT",
    tokenAAddress: TOKENS.WMNT, tokenBAddress: TOKENS.USDT,
    pool: "0xf6C9020c9E915808481757779EDB53DACEaE2415",
    binStep: 15, version: 2
  },
  {
    provider: "merchant_moe",
    tokenA: "WMNT", tokenB: "USDe",
    tokenAAddress: TOKENS.WMNT, tokenBAddress: TOKENS.USDe,
    pool: "0x5d54d430D1FD9425976147318E6080479bffC16D",
    binStep: 25, version: 2
  },
  {
    provider: "merchant_moe",
    tokenA: "WMNT", tokenB: "USDC",
    tokenAAddress: TOKENS.WMNT, tokenBAddress: TOKENS.USDC,
    pool: "0xa1C653c415Db1c00dfd04eE26E624f959A0eD52F",
    binStep: 25, version: 2
  },

  // ---- ETH derivative pairs (V2.2 pools) ----
  {
    provider: "merchant_moe",
    tokenA: "mETH", tokenB: "WETH",
    tokenAAddress: TOKENS.mETH, tokenBAddress: TOKENS.WETH,
    pool: "0x3b6c029E6409f2868769871F9Ed6825b15BDca15",
    binStep: 2, version: 2
  },
  {
    provider: "merchant_moe",
    tokenA: "cmETH", tokenB: "mETH",
    tokenAAddress: TOKENS.cmETH, tokenBAddress: TOKENS.mETH,
    pool: "0x3d887CE4988fb46AEC6E0027171f65DB3526E5f1",
    binStep: 1, version: 2
  },
  {
    provider: "merchant_moe",
    tokenA: "WETH", tokenB: "USDT",
    tokenAAddress: TOKENS.WETH, tokenBAddress: TOKENS.USDT,
    pool: "0xa15C851Afc33aaB6E478d538a4A8C66cacC19686",
    binStep: 10, version: 2
  },
  {
    provider: "merchant_moe",
    tokenA: "mETH", tokenB: "USDT",
    tokenAAddress: TOKENS.mETH, tokenBAddress: TOKENS.USDT,
    pool: "0x3f0047606dCad6177C13742F1854Fc8c999CD2b6",
    binStep: 10, version: 2
  },
  {
    provider: "merchant_moe",
    tokenA: "cmETH", tokenB: "USDT",
    tokenAAddress: TOKENS.cmETH, tokenBAddress: TOKENS.USDT,
    pool: "0x91c5aee46eba5f6b38b962ee248b9cef04b05244",
    binStep: 10, version: 2
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
  // NOTE: USDT0/WMNT removed — pool 0x07c410... has no deployed contract
  // and Agni factory returns zero-address at all fee tiers.

  // ---- USDT pairs on Agni ----
  {
    provider: "agni",
    tokenA: "USDC", tokenB: "USDT",
    tokenAAddress: TOKENS.USDC, tokenBAddress: TOKENS.USDT,
    pool: "0x6488f911c6Cd86c289aa319C5A826Dcf8F1cA065",
    feeTier: 100 // 0.01%
  },
  {
    provider: "agni",
    tokenA: "WMNT", tokenB: "USDT",
    tokenAAddress: TOKENS.WMNT, tokenBAddress: TOKENS.USDT,
    pool: "0xD08C50F7E69e9aEB2867DefF4A8053d9A855e26A",
    feeTier: 500 // 0.05%
  },
  {
    provider: "agni",
    tokenA: "WETH", tokenB: "USDT",
    tokenAAddress: TOKENS.WETH, tokenBAddress: TOKENS.USDT,
    pool: "0x628f7131CF43e88EBe3921Ae78C4bA0C31872bd4",
    feeTier: 500 // 0.05%
  }
];

// ---------------------------------------------------------------------------
// xStocks RWA token addresses (Fluxion, all paired with USDC)
// Source: mantle-xyz/fluxion-mm-monitor-tools configs/pools.yaml
// ---------------------------------------------------------------------------

export const XSTOCKS = {
  wTSLAx: "0x43680abf18cf54898be84c6ef78237cfbd441883",
  wAAPLx: "0x5aa7649fdbda47de64a07ac81d64b682af9c0724",
  wCRCLx: "0xa90872aca656ebe47bdebf3b19ec9dd9c5adc7f8",
  wSPYx: "0xc88fcd8b874fdb3256e8b55b3decb8c24eab4c02",
  wHOODx: "0x953707d7a1cb30cc5c636bda8eaebe410341eb14",
  wMSTRx: "0x266e5923f6118f8b340ca5a23ae7f71897361476",
  wNVDAx: "0x93e62845c1dd5822ebc807ab71a5fb750decd15a",
  wGOOGLx: "0x1630f08370917e79df0b7572395a5e907508bbbc",
  wMETAx: "0x4e41a262caa93c6575d336e0a4eb79f3c67caa06",
  wQQQx: "0xdbd9232fee15351068fe02f0683146e16d9f2cea"
} as const;

// ---------------------------------------------------------------------------
// Fluxion V3 pairs — xStocks RWA pools (all USDC-paired, fee 3000)
// ---------------------------------------------------------------------------

const FLUXION_PAIRS: V3Pair[] = [
  // ---- DeFi pairs (fee_tier 3000 = 0.3%) ----
  {
    provider: "fluxion",
    tokenA: "WMNT", tokenB: "USDC",
    tokenAAddress: TOKENS.WMNT, tokenBAddress: TOKENS.USDC,
    pool: "0x8748e10925850891643f31beff1132e574260cd7",
    feeTier: 3000
  },
  {
    provider: "fluxion",
    tokenA: "WMNT", tokenB: "USDT0",
    tokenAAddress: TOKENS.WMNT, tokenBAddress: TOKENS.USDT0,
    pool: "0x373c05fbe686fa1f3abf5e37ac74c4fac73d2e95",
    feeTier: 3000
  },
  {
    provider: "fluxion",
    tokenA: "WMNT", tokenB: "USDT",
    tokenAAddress: TOKENS.WMNT, tokenBAddress: TOKENS.USDT,
    pool: "0xc0c94deE13fBD76faB0633924f4fA73e12EC3a1A",
    feeTier: 3000
  },
  {
    provider: "fluxion",
    tokenA: "WETH", tokenB: "mETH",
    tokenAAddress: TOKENS.WETH, tokenBAddress: TOKENS.mETH,
    pool: "0xd2ae16b4f4985db367330052b6551387da584f6f",
    feeTier: 3000
  },
  {
    provider: "fluxion",
    tokenA: "USDC", tokenB: "WETH",
    tokenAAddress: TOKENS.USDC, tokenBAddress: TOKENS.WETH,
    pool: "0xd6ecefcd6f94073a7837af5c791e2180b6e66b90",
    feeTier: 3000
  },
  {
    provider: "fluxion",
    tokenA: "USDC", tokenB: "mETH",
    tokenAAddress: TOKENS.USDC, tokenBAddress: TOKENS.mETH,
    pool: "0xeebc5e596d6c788bcaa5324f44a8f648b746e041",
    feeTier: 3000
  },
  {
    provider: "fluxion",
    tokenA: "USDT0", tokenB: "WETH",
    tokenAAddress: TOKENS.USDT0, tokenBAddress: TOKENS.WETH,
    pool: "0xa7c728c4be834ddaf5c49ee4ced678d8aff49de6",
    feeTier: 3000
  },
  {
    provider: "fluxion",
    tokenA: "USDT0", tokenB: "mETH",
    tokenAAddress: TOKENS.USDT0, tokenBAddress: TOKENS.mETH,
    pool: "0x9756d5b60fe70ba41cd4d01fe04779f556c4b75d",
    feeTier: 3000
  },

  // ---- Ecosystem token pairs (fee_tier 3000 = 0.3%) ----
  {
    provider: "fluxion",
    tokenA: "USDT0", tokenB: "BSB",
    tokenAAddress: TOKENS.USDT0, tokenBAddress: TOKENS.BSB,
    pool: "0xdc16ff7d202bae83b35fd7cdbba28be6b8b13f24",
    feeTier: 3000
  },
  {
    provider: "fluxion",
    tokenA: "ELSA", tokenB: "USDT0",
    tokenAAddress: TOKENS.ELSA, tokenBAddress: TOKENS.USDT0,
    pool: "0xe855dae59c7abfedb47d4ae3bb0faa0b1c52a2bc",
    feeTier: 3000
  },
  {
    provider: "fluxion",
    tokenA: "USDT0", tokenB: "VOOI",
    tokenAAddress: TOKENS.USDT0, tokenBAddress: TOKENS.VOOI,
    pool: "0x2305ad92740d186bf3834d4cca2eee1b3d5fa3fe",
    feeTier: 3000
  },

  // ---- xStocks RWA pairs (USDC / xToken, fee_tier 3000 = 0.3%) ----
  {
    provider: "fluxion",
    tokenA: "USDC", tokenB: "wTSLAx",
    tokenAAddress: TOKENS.USDC, tokenBAddress: XSTOCKS.wTSLAx,
    pool: "0x5e7935d70b5d14b6cf36fbde59944533fab96b3c",
    feeTier: 3000
  },
  {
    provider: "fluxion",
    tokenA: "USDC", tokenB: "wAAPLx",
    tokenAAddress: TOKENS.USDC, tokenBAddress: XSTOCKS.wAAPLx,
    pool: "0x2cc6a607f3445d826b9e29f507b3a2e3b9dae106",
    feeTier: 3000
  },
  {
    provider: "fluxion",
    tokenA: "USDC", tokenB: "wCRCLx",
    tokenAAddress: TOKENS.USDC, tokenBAddress: XSTOCKS.wCRCLx,
    pool: "0x43cf441f5949d52faa105060239543492193c87e",
    feeTier: 3000
  },
  {
    provider: "fluxion",
    tokenA: "USDC", tokenB: "wSPYx",
    tokenAAddress: TOKENS.USDC, tokenBAddress: XSTOCKS.wSPYx,
    pool: "0x373f7a2b95f28f38500eb70652e12038cca3bab8",
    feeTier: 3000
  },
  {
    provider: "fluxion",
    tokenA: "USDC", tokenB: "wHOODx",
    tokenAAddress: TOKENS.USDC, tokenBAddress: XSTOCKS.wHOODx,
    pool: "0x4e23bb828e51cbc03c81d76c844228cc75f6a287",
    feeTier: 3000
  },
  {
    provider: "fluxion",
    tokenA: "USDC", tokenB: "wMSTRx",
    tokenAAddress: TOKENS.USDC, tokenBAddress: XSTOCKS.wMSTRx,
    pool: "0x0e1f84a9e388071e20df101b36c14c817bf81953",
    feeTier: 3000
  },
  {
    provider: "fluxion",
    tokenA: "USDC", tokenB: "wNVDAx",
    tokenAAddress: TOKENS.USDC, tokenBAddress: XSTOCKS.wNVDAx,
    pool: "0xa875ac23d106394d1baaae5bc42b951268bc04e2",
    feeTier: 3000
  },
  {
    provider: "fluxion",
    tokenA: "USDC", tokenB: "wGOOGLx",
    tokenAAddress: TOKENS.USDC, tokenBAddress: XSTOCKS.wGOOGLx,
    pool: "0x66960ed892daf022c5f282c5316c38cb6f0c1333",
    feeTier: 3000
  },
  {
    provider: "fluxion",
    tokenA: "USDC", tokenB: "wMETAx",
    tokenAAddress: TOKENS.USDC, tokenBAddress: XSTOCKS.wMETAx,
    pool: "0x782bd3895a6ac561d0df11b02dd6f9e023f3a497",
    feeTier: 3000
  },
  {
    provider: "fluxion",
    tokenA: "USDC", tokenB: "wQQQx",
    tokenAAddress: TOKENS.USDC, tokenBAddress: XSTOCKS.wQQQx,
    pool: "0x505258001e834251634029742fc73b5cab4fd67d",
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
