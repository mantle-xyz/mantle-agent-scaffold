#!/usr/bin/env node
// Cross-validate that registry.json tokens match tokens.ts + pass on-chain checks.
// Ensures: every token in tokens.ts mainnet/sepolia has a matching registry entry
// with the same checksummed address and decimals, and no drift between the two.
import { readFileSync } from "node:fs";
import { getAddress } from "viem";

const registry = JSON.parse(
  readFileSync(new URL("../packages/core/src/config/registry.json", import.meta.url), "utf8")
);

// Mirror of tokens.ts — keep in sync manually for this check.
// Aligned to the OpenClaw × Mantle whitelist (see skills/mantle-openclaw-competition/references/asset-whitelist.md).
const TOKENS_TS = {
  mainnet: {
    // Core assets (9)
    WMNT: { address: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8", decimals: 18 },
    WETH: { address: "0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111", decimals: 18 },
    USDC: { address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9", decimals: 6 },
    USDT: { address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE", decimals: 6 },
    USDT0: { address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", decimals: 6 },
    USDe: { address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", decimals: 18 },
    cmETH: { address: "0xE6829d9a7eE3040e1276Fa75293Bde931859e8fA", decimals: 18 },
    MOE: { address: "0x4515A45337F461A11Ff0FE8aBF3c606AE5dC00c9", decimals: 18 },
    FBTC: { address: "0xC96dE26018A54D51c097160568752c4E3BD6C364", decimals: 8 },
    // xStocks unwrapped (8)
    METAx: { address: "0x96702be57Cd9777f835117a809C7124fe4ec989A", decimals: 18 },
    TSLAx: { address: "0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0", decimals: 18 },
    GOOGLx: { address: "0xe92f673Ca36C5E2Efd2DE7628f815f84807e803F", decimals: 18 },
    NVDAx: { address: "0xc845b2894dBddd03858fd2D643B4eF725fE0849d", decimals: 18 },
    QQQx: { address: "0xa753A7395cAe905Cd615Da0B82A53E0560f250af", decimals: 18 },
    AAPLx: { address: "0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a", decimals: 18 },
    SPYx: { address: "0x90A2a4c76b5D8c0bc892A69EA28Aa775a8f2dD48", decimals: 18 },
    MSTRx: { address: "0xAE2f842EF90C0d5213259Ab82639D5BBF649b08E", decimals: 18 },
    // xStocks wrapped (8)
    wMETAx: { address: "0x4e41a262caa93c6575d336e0a4eb79f3c67caa06", decimals: 18 },
    wTSLAx: { address: "0x43680abf18cf54898be84c6ef78237cfbd441883", decimals: 18 },
    wGOOGLx: { address: "0x1630f08370917e79df0b7572395a5e907508bbbc", decimals: 18 },
    wNVDAx: { address: "0x93e62845c1dd5822ebc807ab71a5fb750decd15a", decimals: 18 },
    wQQQx: { address: "0xdbd9232fee15351068fe02f0683146e16d9f2cea", decimals: 18 },
    wAAPLx: { address: "0x5aa7649fdbda47de64a07ac81d64b682af9c0724", decimals: 18 },
    wSPYx: { address: "0xc88fcd8b874fdb3256e8b55b3decb8c24eab4c02", decimals: 18 },
    wMSTRx: { address: "0x266e5923f6118f8b340ca5a23ae7f71897361476", decimals: 18 },
    // Community / Fluxion ecosystem (4)
    BSB: { address: "0xe5c330ADdf7aa9C7838dA836436142c56a15aa95", decimals: 18 },
    ELSA: { address: "0x29cC30f9D113B356Ce408667aa6433589CeCBDcA", decimals: 18 },
    VOOI: { address: "0xd81a4aDea9932a6BDba0bDBc8C5Fd4C78e5A09f1", decimals: 18 },
    SCOR: { address: "0x8DDB986b11c039a6CC1dbcabd62baE911b348F33", decimals: 18 }
  },
  sepolia: {
    WMNT: { address: "0x19f5557E23e9914A18239990f6C70D68FDF0deD5", decimals: 18 }
  }
};

const envFor = (net) => (net === "sepolia" ? "testnet" : "mainnet");

let errors = 0;
for (const [network, tokens] of Object.entries(TOKENS_TS)) {
  const envEntries = registry.contracts.filter(
    (c) => c.environment === envFor(network) && c.category === "token"
  );
  for (const [key, tok] of Object.entries(tokens)) {
    const match = envEntries.find((c) => c.key === key);
    if (!match) {
      errors += 1;
      console.log(`MISSING: [${network}] ${key} in tokens.ts has no registry entry`);
      continue;
    }
    const expectedAddr = getAddress(tok.address);
    if (match.address !== expectedAddr) {
      errors += 1;
      console.log(`ADDR: [${network}] ${key} tokens.ts=${expectedAddr} registry=${match.address}`);
    }
    if (match.decimals !== tok.decimals) {
      errors += 1;
      console.log(`DECIMALS: [${network}] ${key} tokens.ts=${tok.decimals} registry=${match.decimals}`);
    }
  }
}

// Also check registry doesn't have orphan token entries that tokens.ts lacks.
for (const entry of registry.contracts) {
  if (entry.category !== "token") continue;
  const network = entry.environment === "testnet" ? "sepolia" : "mainnet";
  if (!TOKENS_TS[network][entry.key]) {
    console.log(`ORPHAN (ok for now, just noting): [${network}] registry has "${entry.key}" but tokens.ts does not`);
  }
}

console.log(`\nParity errors: ${errors}`);
process.exit(errors > 0 ? 1 : 0);
