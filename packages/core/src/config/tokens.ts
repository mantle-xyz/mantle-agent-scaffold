import type { Network } from "../types.js";

export interface TokenEntry {
  address: string;
  decimals: number;
  name: string;
  symbol: string;
}

export const MANTLE_TOKENS: Record<Network, Record<string, TokenEntry>> = {
  mainnet: {
    MNT: { address: "native", decimals: 18, name: "Mantle", symbol: "MNT" },
    WMNT: {
      address: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
      decimals: 18,
      name: "Wrapped Mantle",
      symbol: "WMNT"
    },
    WETH: {
      address: "0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111",
      decimals: 18,
      name: "Wrapped Ether",
      symbol: "WETH"
    },
    USDC: {
      address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
      decimals: 6,
      name: "USD Coin",
      symbol: "USDC"
    },
    USDT: {
      address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
      decimals: 6,
      name: "Tether",
      symbol: "USDT"
    },
    USDT0: {
      address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
      decimals: 6,
      name: "USDT0",
      symbol: "USDT0"
    },
    USDe: {
      address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
      decimals: 18,
      name: "USDe",
      symbol: "USDe"
    },
    sUSDe: {
      address: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2",
      decimals: 18,
      name: "Staked USDe",
      symbol: "sUSDe"
    },
    mETH: {
      address: "0xcDA86A272531e8640cD7F1a92c01839911B90bb0",
      decimals: 18,
      name: "Mantle Staked ETH",
      symbol: "mETH"
    },
    cmETH: {
      address: "0xE6829d9a7eE3040e1276Fa75293Bde931859e8fA",
      decimals: 18,
      name: "Restaked mETH",
      symbol: "cmETH"
    },
    MOE: {
      address: "0x4515A45337F461A11Ff0FE8aBF3c606AE5dC00c9",
      decimals: 18,
      name: "Moe Token",
      symbol: "MOE"
    },
    FBTC: {
      address: "0xC96dE26018A54D51c097160568752c4E3BD6C364",
      decimals: 8,
      name: "FBTC",
      symbol: "FBTC"
    },
    GHO: {
      address: "0xfc421aD3C883Bf9E7C4f42dE845C4e4405799e73",
      decimals: 18,
      name: "GHO",
      symbol: "GHO"
    },
    // xStocks RWA tokens (all 18 decimals)
    wTSLAx: {
      address: "0x43680abf18cf54898be84c6ef78237cfbd441883",
      decimals: 18,
      name: "Tesla xStock",
      symbol: "wTSLAx"
    },
    wAAPLx: {
      address: "0x5aa7649fdbda47de64a07ac81d64b682af9c0724",
      decimals: 18,
      name: "Apple xStock",
      symbol: "wAAPLx"
    },
    wNVDAx: {
      address: "0x93e62845c1dd5822ebc807ab71a5fb750decd15a",
      decimals: 18,
      name: "Nvidia xStock",
      symbol: "wNVDAx"
    },
    wGOOGLx: {
      address: "0x1630f08370917e79df0b7572395a5e907508bbbc",
      decimals: 18,
      name: "Alphabet xStock",
      symbol: "wGOOGLx"
    },
    wMETAx: {
      address: "0x4e41a262caa93c6575d336e0a4eb79f3c67caa06",
      decimals: 18,
      name: "Meta xStock",
      symbol: "wMETAx"
    },
    wQQQx: {
      address: "0xdbd9232fee15351068fe02f0683146e16d9f2cea",
      decimals: 18,
      name: "Nasdaq xStock",
      symbol: "wQQQx"
    },
    wSPYx: {
      address: "0xc88fcd8b874fdb3256e8b55b3decb8c24eab4c02",
      decimals: 18,
      name: "S&P 500 xStock",
      symbol: "wSPYx"
    },
    wMSTRx: {
      address: "0x266e5923f6118f8b340ca5a23ae7f71897361476",
      decimals: 18,
      name: "MicroStrategy xStock",
      symbol: "wMSTRx"
    },
    wHOODx: {
      address: "0x953707d7a1cb30cc5c636bda8eaebe410341eb14",
      decimals: 18,
      name: "Robinhood xStock",
      symbol: "wHOODx"
    },
    wCRCLx: {
      address: "0xa90872aca656ebe47bdebf3b19ec9dd9c5adc7f8",
      decimals: 18,
      name: "Circle xStock",
      symbol: "wCRCLx"
    },
    // Fluxion ecosystem tokens
    BSB: {
      address: "0xe5c330ADdf7aa9C7838dA836436142c56a15aa95",
      decimals: 18,
      name: "BSB",
      symbol: "BSB"
    },
    ELSA: {
      address: "0x29cC30f9D113B356Ce408667aa6433589CeCBDcA",
      decimals: 18,
      name: "ELSA",
      symbol: "ELSA"
    },
    VOOI: {
      address: "0xd81a4aDea9932a6BDba0bDBc8C5Fd4C78e5A09f1",
      decimals: 18,
      name: "VOOI",
      symbol: "VOOI"
    }
  },
  sepolia: {
    MNT: { address: "native", decimals: 18, name: "Mantle", symbol: "MNT" },
    WMNT: {
      address: "0x19f5557E23e9914A18239990f6C70D68FDF0deD5",
      decimals: 18,
      name: "Wrapped Mantle",
      symbol: "WMNT"
    }
  }
};
