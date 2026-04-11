/**
 * Aave V3 Mantle reserve assets — hardcoded from the official aave-address-book.
 *
 * Source: https://github.com/bgd-labs/aave-address-book/blob/main/src/ts/AaveV3Mantle.ts
 *
 * Each entry contains the underlying token, its Aave aToken (deposit receipt),
 * and variable debt token. Agents can use this registry to:
 *  - Know which assets are eligible for supply/borrow on Aave V3
 *  - Resolve aToken/debtToken addresses for portfolio valuation
 *  - Skip on-chain lookups for known reserves
 */

export interface AaveReserveAsset {
  /** Reserve index in the Aave Pool (0-based). */
  id: number;
  /** Human-readable symbol. */
  symbol: string;
  /** Underlying ERC-20 token address. */
  underlying: string;
  /** aToken address (deposit receipt, balance grows with interest). */
  aToken: string;
  /** Variable debt token address (represents outstanding borrow). */
  variableDebtToken: string;
  /** Token decimals. */
  decimals: number;

  // ── Isolation Mode ──────────────────────────────────────────────────
  /**
   * True when supplying this asset as the ONLY collateral puts the user
   * into Isolation Mode (i.e. the on-chain debt ceiling > 0).
   */
  isolationMode: boolean;
  /**
   * Max total debt (in whole USD) allowed across ALL users who use this
   * asset in isolation.  0 = not an isolation-mode asset.
   * On-chain value (Pool.getConfiguration bits 212-251) has 2 decimal places;
   * this field is already divided by 100.
   */
  debtCeilingUsd: number;
  /**
   * True when this asset can be borrowed by a user who is in Isolation
   * Mode.  Sourced from Pool.getConfiguration() bit 61.
   */
  borrowableInIsolation: boolean;
}

export const AAVE_V3_MANTLE_RESERVES: AaveReserveAsset[] = [
  {
    id: 0,
    symbol: "WETH",
    underlying: "0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111",
    aToken: "0xeAC30Ed8609F564aE65C809C4bf42dB2fF426D2C",
    variableDebtToken: "0x0baF5974838114e7001D02782e6B1D8aEE1fc626",
    decimals: 18,
    isolationMode: true,
    debtCeilingUsd: 30_000_000, // $30M (on-chain raw 3_000_000_000 / 100)
    borrowableInIsolation: false
  },
  {
    id: 1,
    symbol: "WMNT",
    underlying: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
    aToken: "0x85d86061e94CE01D3DA0f9EFa289c86ff136125a",
    variableDebtToken: "0x9c27A8ffacAbdEE0Ac5c415E018D295BB6444F0E",
    decimals: 18,
    isolationMode: true,
    debtCeilingUsd: 2_000_000, // $2M (on-chain raw 200_000_000 / 100)
    borrowableInIsolation: false
  },
  {
    id: 2,
    symbol: "USDT0",
    underlying: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
    aToken: "0x7053bAD224F0C021839f6AC645BdaE5F8b585b69",
    variableDebtToken: "0x5d9e4663d3d532179c404dBe9edF93045F89aDed",
    decimals: 6,
    isolationMode: false,
    debtCeilingUsd: 0,
    borrowableInIsolation: true
  },
  {
    id: 3,
    symbol: "USDC",
    underlying: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
    aToken: "0xcb8164415274515867ec43CbD284ab5d6d2b304F",
    variableDebtToken: "0xCea474BDa7Ad0a8F62e938a5563edfAEf7368Fc0",
    decimals: 6,
    isolationMode: false,
    debtCeilingUsd: 0,
    borrowableInIsolation: true
  },
  {
    id: 4,
    symbol: "USDe",
    underlying: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
    aToken: "0xb9aCA933C9c0aa854a6DBb7b12f0CC3FdaC15ee7",
    variableDebtToken: "0x0169FD279c8c656037E5D199Cff8137f1e2d807c",
    decimals: 18,
    isolationMode: false,
    debtCeilingUsd: 0,
    borrowableInIsolation: true
  },
  {
    id: 5,
    symbol: "sUSDe",
    underlying: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2",
    aToken: "0xaf972F332FF79bd32A6CB6B54f903eA0F9b16C2a",
    variableDebtToken: "0xc42B44c65bBe7AA8E5b02416918688c244ec7847",
    decimals: 18,
    isolationMode: false,
    debtCeilingUsd: 0,
    borrowableInIsolation: false
  },
  {
    id: 6,
    symbol: "FBTC",
    underlying: "0xC96dE26018A54D51c097160568752c4E3BD6C364",
    aToken: "0xfa14c9DE267b59A586043372bd98Ed99e3Ee0533",
    variableDebtToken: "0x691AbCD512C1Cfef99442b0ACD3eD98Ee7F4e64E",
    decimals: 8,
    isolationMode: false,
    debtCeilingUsd: 0,
    borrowableInIsolation: false
  },
  {
    id: 7,
    symbol: "syrupUSDT",
    underlying: "0x051665f2455116e929b9972c36d23070F5054Ce0",
    aToken: "0xF8400F3FA9cD9F9E84e93cD9De9f14EB7B5b59b5",
    variableDebtToken: "0x2E20c5291CD675bFe52a533a6208588f5484999e",
    decimals: 6,
    isolationMode: false,
    debtCeilingUsd: 0,
    borrowableInIsolation: false
  },
  {
    id: 8,
    symbol: "wrsETH",
    underlying: "0x93e855643e940D025bE2e529272e4Dbd15a2Cf74",
    aToken: "0x5cC6999aC46F4627309a7ce0F321a3f45D138ED5",
    variableDebtToken: "0x7C5549DE0dEb930bAb1e11B075151a19e400605c",
    decimals: 18,
    isolationMode: false,
    debtCeilingUsd: 0,
    borrowableInIsolation: false
  },
  {
    id: 9,
    symbol: "GHO",
    underlying: "0xfc421aD3C883Bf9E7C4f42dE845C4e4405799e73",
    aToken: "0x8917d4eE4609f991b559DAF8D0aD1b892c13B127",
    variableDebtToken: "0xeE1eABe23fA42028809F587B8fE1936b154d2620",
    decimals: 18,
    isolationMode: false,
    debtCeilingUsd: 0,
    borrowableInIsolation: true
  }
];

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

const bySymbol = new Map(
  AAVE_V3_MANTLE_RESERVES.map((r) => [r.symbol.toLowerCase(), r])
);
const byUnderlying = new Map(
  AAVE_V3_MANTLE_RESERVES.map((r) => [r.underlying.toLowerCase(), r])
);

/** Find a reserve by symbol (case-insensitive). */
export function findReserveBySymbol(symbol: string): AaveReserveAsset | null {
  return bySymbol.get(symbol.toLowerCase()) ?? null;
}

/** Find a reserve by underlying token address. */
export function findReserveByUnderlying(
  address: string
): AaveReserveAsset | null {
  return byUnderlying.get(address.toLowerCase()) ?? null;
}

/** Check whether a token is a supported Aave V3 reserve on Mantle. */
export function isAaveReserve(symbolOrAddress: string): boolean {
  const lower = symbolOrAddress.toLowerCase();
  return bySymbol.has(lower) || byUnderlying.has(lower);
}

/** Get all reserve symbols. */
export function aaveReserveSymbols(): string[] {
  return AAVE_V3_MANTLE_RESERVES.map((r) => r.symbol);
}

/** Symbols of reserves whose debtCeiling > 0 (supplying them triggers Isolation Mode). */
export function isolationModeSymbols(): string[] {
  return AAVE_V3_MANTLE_RESERVES.filter((r) => r.isolationMode).map((r) => r.symbol);
}

/** Symbols of reserves that CAN be borrowed while in Isolation Mode. */
export function isolationBorrowableSymbols(): string[] {
  return AAVE_V3_MANTLE_RESERVES.filter((r) => r.borrowableInIsolation).map((r) => r.symbol);
}
