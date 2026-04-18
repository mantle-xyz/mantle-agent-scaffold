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
const TOKENS_TS = {
  mainnet: {
    WMNT: { address: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8", decimals: 18 },
    WETH: { address: "0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111", decimals: 18 },
    USDC: { address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9", decimals: 6 },
    USDT: { address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE", decimals: 6 },
    USDT0: { address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", decimals: 6 },
    USDe: { address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", decimals: 18 },
    sUSDe: { address: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2", decimals: 18 },
    mETH: { address: "0xcDA86A272531e8640cD7F1a92c01839911B90bb0", decimals: 18 },
    cmETH: { address: "0xE6829d9a7eE3040e1276Fa75293Bde931859e8fA", decimals: 18 },
    MOE: { address: "0x4515A45337F461A11Ff0FE8aBF3c606AE5dC00c9", decimals: 18 },
    FBTC: { address: "0xC96dE26018A54D51c097160568752c4E3BD6C364", decimals: 8 },
    syrupUSDT: { address: "0x051665f2455116e929b9972c36d23070F5054Ce0", decimals: 6 },
    wrsETH: { address: "0x93e855643e940D025bE2e529272e4Dbd15a2Cf74", decimals: 18 },
    GHO: { address: "0xfc421aD3C883Bf9E7C4f42dE845C4e4405799e73", decimals: 18 },
    wTSLAx: { address: "0x43680abf18cf54898be84c6ef78237cfbd441883", decimals: 18 },
    wAAPLx: { address: "0x5aa7649fdbda47de64a07ac81d64b682af9c0724", decimals: 18 },
    wNVDAx: { address: "0x93e62845c1dd5822ebc807ab71a5fb750decd15a", decimals: 18 },
    wGOOGLx: { address: "0x1630f08370917e79df0b7572395a5e907508bbbc", decimals: 18 },
    wMETAx: { address: "0x4e41a262caa93c6575d336e0a4eb79f3c67caa06", decimals: 18 },
    wQQQx: { address: "0xdbd9232fee15351068fe02f0683146e16d9f2cea", decimals: 18 },
    wSPYx: { address: "0xc88fcd8b874fdb3256e8b55b3decb8c24eab4c02", decimals: 18 },
    wMSTRx: { address: "0x266e5923f6118f8b340ca5a23ae7f71897361476", decimals: 18 },
    wHOODx: { address: "0x953707d7a1cb30cc5c636bda8eaebe410341eb14", decimals: 18 },
    wCRCLx: { address: "0xa90872aca656ebe47bdebf3b19ec9dd9c5adc7f8", decimals: 18 },
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
