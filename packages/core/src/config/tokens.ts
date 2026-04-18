import type { Network } from "../types.js";

export interface TokenEntry {
  address: string;
  decimals: number;
  name: string;
  symbol: string;
}

/**
 * Mantle token registry — strictly scoped to the OpenClaw / RealClaw whitelist.
 *
 * Authoritative source:
 *   skills/mantle-openclaw-competition/references/asset-whitelist.md
 *
 * Hard Constraint #10: any token not present here must be refused before a
 * CLI call is made — even if the user insists, accepts risk, or asks to
 * "just try". Do not silently substitute a similar asset (e.g. "stETH" ->
 * cmETH); refuse and cite the whitelist.
 *
 * MNT is the native gas token; it has no ERC-20 contract. Use WMNT
 * (`swap wrap-mnt` / `swap unwrap-mnt`) for any ERC-20 interaction.
 */
export const MANTLE_TOKENS: Record<Network, Record<string, TokenEntry>> = {
  mainnet: {
    // ---- Core assets (9; MNT is native, no contract) ----
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

    // ---- xStocks unwrapped (8). Fluxion-only, USDC pair, fee_tier=3000 ----
    METAx: {
      address: "0x96702be57Cd9777f835117a809C7124fe4ec989A",
      decimals: 18,
      name: "Meta xStock",
      symbol: "METAx"
    },
    TSLAx: {
      address: "0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0",
      decimals: 18,
      name: "Tesla xStock",
      symbol: "TSLAx"
    },
    GOOGLx: {
      address: "0xe92f673Ca36C5E2Efd2DE7628f815f84807e803F",
      decimals: 18,
      name: "Alphabet xStock",
      symbol: "GOOGLx"
    },
    NVDAx: {
      address: "0xc845b2894dBddd03858fd2D643B4eF725fE0849d",
      decimals: 18,
      name: "NVIDIA xStock",
      symbol: "NVDAx"
    },
    QQQx: {
      address: "0xa753A7395cAe905Cd615Da0B82A53E0560f250af",
      decimals: 18,
      name: "Nasdaq xStock",
      symbol: "QQQx"
    },
    AAPLx: {
      address: "0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a",
      decimals: 18,
      name: "Apple xStock",
      symbol: "AAPLx"
    },
    SPYx: {
      address: "0x90A2a4c76b5D8c0bc892A69EA28Aa775a8f2dD48",
      decimals: 18,
      name: "S&P 500 xStock",
      symbol: "SPYx"
    },
    MSTRx: {
      address: "0xAE2f842EF90C0d5213259Ab82639D5BBF649b08E",
      decimals: 18,
      name: "MicroStrategy xStock",
      symbol: "MSTRx"
    },

    // ---- xStocks wrapped (8). CLI symbol = w<TICKER>x ----
    wMETAx: {
      address: "0x4E41a262cAA93C6575d336E0a4eb79f3c67caa06",
      decimals: 18,
      name: "Wrapped Meta xStock",
      symbol: "wMETAx"
    },
    wTSLAx: {
      address: "0x43680aBF18cf54898Be84C6eF78237CFBD441883",
      decimals: 18,
      name: "Wrapped Tesla xStock",
      symbol: "wTSLAx"
    },
    wGOOGLx: {
      address: "0x1630F08370917E79df0B7572395a5e907508bBBc",
      decimals: 18,
      name: "Wrapped Alphabet xStock",
      symbol: "wGOOGLx"
    },
    wNVDAx: {
      address: "0x93E62845C1DD5822EbC807ab71A5Fb750DecD15A",
      decimals: 18,
      name: "Wrapped NVIDIA xStock",
      symbol: "wNVDAx"
    },
    wQQQx: {
      address: "0xdbD9232fee15351068Fe02F0683146e16D9f2cEa",
      decimals: 18,
      name: "Wrapped Nasdaq xStock",
      symbol: "wQQQx"
    },
    wAAPLx: {
      address: "0x5AA7649fdbDa47De64A07aC81D64B682AF9C0724",
      decimals: 18,
      name: "Wrapped Apple xStock",
      symbol: "wAAPLx"
    },
    wSPYx: {
      address: "0xc88FcD8B874fDb3256E8B55b3decB8c24EAb4c02",
      decimals: 18,
      name: "Wrapped S&P 500 xStock",
      symbol: "wSPYx"
    },
    wMSTRx: {
      address: "0x266E5923F6118F8b340cA5a23AE7f71897361476",
      decimals: 18,
      name: "Wrapped MicroStrategy xStock",
      symbol: "wMSTRx"
    },

    // ---- Community tokens (4). Fluxion-only, typically USDT0-paired ----
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
    },
    SCOR: {
      address: "0x8DDB986b11c039a6CC1dbcabd62baE911b348F33",
      decimals: 18,
      name: "SCOR",
      symbol: "SCOR"
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

// ---------------------------------------------------------------------------
// Whitelist helpers — used by defi-write tools to enforce Hard Constraint #10
// on token addresses. Complements `isWhitelistedContract` in protocols.ts
// which enforces the same rule on *contract* targets.
// ---------------------------------------------------------------------------

/**
 * Lowercase set of whitelisted ERC-20 addresses per network, lazily built from
 * MANTLE_TOKENS. We exclude the native MNT entry (address === "native")
 * because it has no ERC-20 contract.
 */
const WHITELISTED_TOKEN_ADDRESSES: Record<Network, Set<string>> = (() => {
  const build = (network: Network) =>
    new Set(
      Object.values(MANTLE_TOKENS[network])
        .map((t) => t.address)
        .filter((a) => a !== "native")
        .map((a) => a.toLowerCase())
    );
  return { mainnet: build("mainnet"), sepolia: build("sepolia") };
})();

/**
 * Return true if the given ERC-20 address is on the OpenClaw × Mantle token
 * whitelist for this network. Accepts any case — the comparison is lowercase.
 *
 * Non-mainnet networks (sepolia) intentionally use the same check; the
 * sepolia whitelist only contains WMNT, so anything else will be refused
 * before a sepolia tx can be built. Raw-address callers never bypass
 * whitelist enforcement regardless of network.
 */
export function isWhitelistedTokenAddress(
  address: string,
  network: Network
): boolean {
  if (!address || address === "native") return false;
  return WHITELISTED_TOKEN_ADDRESSES[network].has(address.toLowerCase());
}

/**
 * Default token whitelist used by portfolio / balance scans when the caller
 * does not explicitly enumerate tokens. Covers every whitelisted ERC-20 on
 * Mantle so `mantle-cli account token-balances <address>` returns a useful
 * answer out-of-the-box.
 *
 * Notes:
 *  - MNT (the native gas token) is NOT listed here. Query it separately via
 *    `mantle_getBalance` — token balance tools only handle ERC-20s.
 *  - USDT0 (LayerZero OFT Tether, 0x779D…3736) is included because it is a
 *    distinct asset from bridged USDT on Mantle and is otherwise easy to
 *    miss in portfolio scans.
 */
export const PORTFOLIO_DEFAULT_TOKENS: Record<Network, readonly string[]> = {
  mainnet: [
    // Majors & stables
    "WMNT",
    "WETH",
    "USDC",
    "USDT",
    "USDT0",
    "USDe",
    // LSTs / restaking
    "cmETH",
    // Ecosystem governance / DEX
    "MOE",
    // BTC-backed
    "FBTC",
    // xStocks unwrapped (RWA equities)
    "METAx",
    "TSLAx",
    "GOOGLx",
    "NVDAx",
    "QQQx",
    "AAPLx",
    "SPYx",
    "MSTRx",
    // xStocks wrapped
    "wMETAx",
    "wTSLAx",
    "wGOOGLx",
    "wNVDAx",
    "wQQQx",
    "wAAPLx",
    "wSPYx",
    "wMSTRx",
    // Community / Fluxion ecosystem
    "BSB",
    "ELSA",
    "VOOI",
    "SCOR"
  ],
  sepolia: ["WMNT"]
};
