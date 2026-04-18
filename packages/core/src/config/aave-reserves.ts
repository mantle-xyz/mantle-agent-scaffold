/**
 * Aave V3 Mantle reserve assets — strictly filtered to the OpenClaw /
 * RealClaw whitelist.
 *
 * Source: https://github.com/bgd-labs/aave-address-book/blob/main/src/ts/AaveV3Mantle.ts
 * Whitelist: skills/mantle-openclaw-competition/references/asset-whitelist.md
 *
 * NOTE: the Aave Pool lists additional reserves on-chain (sUSDe, syrupUSDT,
 * wrsETH, GHO). Those are NOT on the whitelist and have been removed from
 * this table so that tx builders cannot route through them. The `id` field
 * is preserved verbatim from the on-chain reserve index — do not renumber.
 *
 * Each entry contains the underlying token, its Aave aToken (deposit receipt),
 * and variable debt token. Agents can use this registry to:
 *  - Know which whitelisted assets are eligible for supply/borrow on Aave V3
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
    id: 6,
    symbol: "FBTC",
    underlying: "0xC96dE26018A54D51c097160568752c4E3BD6C364",
    aToken: "0xfa14c9DE267b59A586043372bd98Ed99e3Ee0533",
    variableDebtToken: "0x691AbCD512C1Cfef99442b0ACD3eD98Ee7F4e64E",
    decimals: 8,
    isolationMode: false,
    debtCeilingUsd: 0,
    borrowableInIsolation: false
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
