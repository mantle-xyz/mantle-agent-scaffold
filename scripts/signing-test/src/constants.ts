/**
 * Shared constants for Mantle mainnet signing tests.
 * Token addresses, contract addresses, and scenario amounts.
 */

export const NETWORK = "mainnet";
export const CHAIN_ID = 5000;

// --- Token addresses (Mantle mainnet) ---------------------------------------
export const WMNT = "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8" as const;
export const USDC = "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9" as const;
export const USDT = "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE" as const;
export const USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736" as const;
export const USDe = "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34" as const;

export const TOKEN_DECIMALS: Record<string, number> = {
  [WMNT]: 18,
  [USDC]: 6,
  [USDT]: 6,
  [USDT0]: 6,
  [USDe]: 18,
};

export const TOKEN_SYMBOL: Record<string, string> = {
  [WMNT]: "WMNT",
  [USDC]: "USDC",
  [USDT]: "USDT",
  [USDT0]: "USDT0",
  [USDe]: "USDe",
};

// --- Whitelisted protocol contracts -----------------------------------------
export const AGNI_POSITION_MANAGER = "0x218bf598D1453383e2F4AA7b14fFB9BfB102D637" as const;
export const AGNI_SWAP_ROUTER      = "0x319B69888b0d11cEC22caA5034e25FfFBDc88421" as const;
export const MOE_LB_ROUTER         = "0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a" as const;
export const AAVE_POOL             = "0x458f293454fe0d67ec0655f3672301301dd51422" as const;

// --- DEX pool registry (on-chain verified) ----------------------------------
export const POOLS = {
  // Agni V3 pools
  agni_wmnt_usdc: {
    address: "0x8e2c009e45420d2b36bc15315f9de8ceca2cc724",
    feeTier: 10000,
    tickSpacing: 200,
    fullRangeTick: 887200,
  },
  agni_wmnt_usde: {
    address: "0xeafc4d6d4c3391cd4fc10c85d2f5f972d58c0dd5",
    feeTier: 2500,
    tickSpacing: 50,
    fullRangeTick: 887250,
  },
  agni_wmnt_usdt: {
    address: "0xD08C50F7E69e9aEB2867DefF4A8053d9A855e26A",
    feeTier: 500,
    tickSpacing: 10,
    fullRangeTick: 887270,
  },
  // Moe LB pools
  moe_wmnt_usdt: {
    address: "0xf6C9020c9E915808481757779EDB53DACEaE2415",
    binStep: 15,
    tokenX: WMNT, tokenY: USDT,   // deploy order, NOT address sort
  },
  moe_wmnt_usdc: {
    address: "0xa1C653c415Db1c00dfd04eE26E624f959A0eD52F",
    binStep: 25,
    tokenX: USDC, tokenY: WMNT,
  },
  moe_wmnt_usde: {
    address: "0x5d54d430D1FD9425976147318E6080479bffC16D",
    binStep: 25,
    tokenX: USDe, tokenY: WMNT,
  },
  moe_wmnt_usdt0: {
    address: "0xC0729cDE19741dE280b230D650F0fDad2aD79D09",
    binStep: 25,
    tokenX: WMNT, tokenY: USDT0,
  },
} as const;

// --- Block explorer ---------------------------------------------------------
export const EXPLORER_TX = "https://mantlescan.xyz/tx/";
