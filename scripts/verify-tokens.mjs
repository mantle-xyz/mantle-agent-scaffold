#!/usr/bin/env node
// Verify on-chain metadata (symbol / name / decimals) for every token we intend
// to add to registry.json. Prints a markdown-style report plus a JSON summary.
//
// Usage: node scripts/verify-tokens.mjs [--network mainnet|sepolia]
// Output is written to stdout; failures exit non-zero.

import { createPublicClient, http, getAddress } from "viem";

const NETWORKS = {
  mainnet: {
    chainId: 5000,
    rpcs: [
      "https://rpc.mantle.xyz",
      "https://mantle-mainnet.public.blastapi.io",
      "https://mantle.drpc.org"
    ]
  },
  sepolia: {
    chainId: 5003,
    rpcs: ["https://rpc.sepolia.mantle.xyz", "https://mantle-sepolia.drpc.org"]
  }
};

// Expected values, drawn from packages/core/src/config/tokens.ts
// Aligned to the OpenClaw × Mantle whitelist (see skills/mantle-openclaw-competition/references/asset-whitelist.md).
// Non-whitelist tokens (e.g. mETH, sUSDe, GHO, wrsETH, syrupUSDT, wHOODx, wCRCLx)
// are intentionally excluded — do not add them back.
const EXPECTED = {
  mainnet: [
    // Core (9; MNT is native, no contract)
    ["WMNT", "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8", 18, "Wrapped Mantle"],
    ["WETH", "0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111", 18, "Wrapped Ether"],
    ["USDC", "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9", 6, "USD Coin"],
    ["USDT", "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE", 6, "Tether"],
    ["USDT0", "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", 6, "USDT0"],
    ["USDe", "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", 18, "USDe"],
    ["cmETH", "0xE6829d9a7eE3040e1276Fa75293Bde931859e8fA", 18, "Restaked mETH"],
    ["FBTC", "0xC96dE26018A54D51c097160568752c4E3BD6C364", 8, "FBTC"],
    ["MOE", "0x4515A45337F461A11Ff0FE8aBF3c606AE5dC00c9", 18, "Moe Token"],
    // xStocks unwrapped (8) — Fluxion-only, USDC-paired
    ["METAx", "0x96702be57Cd9777f835117a809C7124fe4ec989A", 18, "Meta xStock"],
    ["TSLAx", "0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0", 18, "Tesla xStock"],
    ["GOOGLx", "0xe92f673Ca36C5E2Efd2DE7628f815f84807e803F", 18, "Alphabet xStock"],
    ["NVDAx", "0xc845b2894dBddd03858fd2D643B4eF725fE0849d", 18, "NVIDIA xStock"],
    ["QQQx", "0xa753A7395cAe905Cd615Da0B82A53E0560f250af", 18, "Nasdaq xStock"],
    ["AAPLx", "0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a", 18, "Apple xStock"],
    ["SPYx", "0x90A2a4c76b5D8c0bc892A69EA28Aa775a8f2dD48", 18, "S&P 500 xStock"],
    ["MSTRx", "0xAE2f842EF90C0d5213259Ab82639D5BBF649b08E", 18, "MicroStrategy xStock"],
    // xStocks wrapped (8)
    ["wTSLAx", "0x43680abf18cf54898be84c6ef78237cfbd441883", 18, "Tesla xStock"],
    ["wAAPLx", "0x5aa7649fdbda47de64a07ac81d64b682af9c0724", 18, "Apple xStock"],
    ["wNVDAx", "0x93e62845c1dd5822ebc807ab71a5fb750decd15a", 18, "Nvidia xStock"],
    ["wGOOGLx", "0x1630f08370917e79df0b7572395a5e907508bbbc", 18, "Alphabet xStock"],
    ["wMETAx", "0x4e41a262caa93c6575d336e0a4eb79f3c67caa06", 18, "Meta xStock"],
    ["wQQQx", "0xdbd9232fee15351068fe02f0683146e16d9f2cea", 18, "Nasdaq xStock"],
    ["wSPYx", "0xc88fcd8b874fdb3256e8b55b3decb8c24eab4c02", 18, "S&P 500 xStock"],
    ["wMSTRx", "0x266e5923f6118f8b340ca5a23ae7f71897361476", 18, "MicroStrategy xStock"],
    // Fluxion ecosystem / community (4)
    ["BSB", "0xe5c330ADdf7aa9C7838dA836436142c56a15aa95", 18, "BSB"],
    ["ELSA", "0x29cC30f9D113B356Ce408667aa6433589CeCBDcA", 18, "ELSA"],
    ["VOOI", "0xd81a4aDea9932a6BDba0bDBc8C5Fd4C78e5A09f1", 18, "VOOI"],
    ["SCOR", "0x8DDB986b11c039a6CC1dbcabd62baE911b348F33", 18, "SCOR"]
  ],
  sepolia: [
    ["WMNT", "0x19f5557E23e9914A18239990f6C70D68FDF0deD5", 18, "Wrapped Mantle"]
  ]
};

const ERC20_ABI = [
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "symbol", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "name", outputs: [{ type: "string" }], stateMutability: "view", type: "function" }
];

function pickNetwork() {
  const idx = process.argv.indexOf("--network");
  const requested = idx > -1 ? process.argv[idx + 1] : null;
  if (!requested) return ["mainnet", "sepolia"];
  if (!NETWORKS[requested]) {
    console.error(`Unknown network: ${requested}`);
    process.exit(2);
  }
  return [requested];
}

function buildClient(network) {
  const cfg = NETWORKS[network];
  // Cycle RPCs per network; viem's http transport handles retries internally.
  return createPublicClient({
    chain: { id: cfg.chainId, name: network, nativeCurrency: { name: "MNT", symbol: "MNT", decimals: 18 }, rpcUrls: { default: { http: cfg.rpcs } } },
    transport: http(cfg.rpcs[0], { batch: true, retryCount: 2, timeout: 20_000 })
  });
}

async function readToken(client, address) {
  const addr = getAddress(address);
  const [decimals, symbol, name] = await Promise.all([
    client.readContract({ address: addr, abi: ERC20_ABI, functionName: "decimals" }).catch((e) => ({ __error: e.shortMessage ?? e.message })),
    client.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" }).catch((e) => ({ __error: e.shortMessage ?? e.message })),
    client.readContract({ address: addr, abi: ERC20_ABI, functionName: "name" }).catch((e) => ({ __error: e.shortMessage ?? e.message }))
  ]);
  const code = await client.getCode({ address: addr }).catch(() => null);
  return {
    address: addr,
    decimals: typeof decimals === "number" ? decimals : decimals,
    symbol,
    name,
    has_code: !!(code && code !== "0x")
  };
}

function fmtVal(v) {
  if (v && typeof v === "object" && "__error" in v) return `ERR(${v.__error})`;
  return String(v);
}

async function run() {
  const networks = pickNetwork();
  let mismatches = 0;
  const summary = {};
  for (const network of networks) {
    const client = buildClient(network);
    const rows = [];
    summary[network] = [];
    for (const [expKey, address, expDecimals, expName] of EXPECTED[network]) {
      try {
        const r = await readToken(client, address);
        const okDecimals = r.decimals === expDecimals;
        const okCode = r.has_code;
        const okSymbol = typeof r.symbol === "string" && r.symbol.length > 0;
        const okName = typeof r.name === "string" && r.name.length > 0;
        const status = okDecimals && okCode && okSymbol && okName ? "OK" : "MISMATCH";
        if (status !== "OK") mismatches += 1;
        rows.push({ expKey, address, expDecimals, expName, onchain: r, status });
        summary[network].push({ expKey, address, expDecimals, onchain_decimals: r.decimals, onchain_symbol: r.symbol, onchain_name: r.name, has_code: r.has_code, status });
        console.log(
          `[${network}] ${status.padEnd(8)} ${expKey.padEnd(10)} ${address}  exp_decimals=${expDecimals} onchain=${fmtVal(r.decimals)}  symbol=${fmtVal(r.symbol)}  name=${fmtVal(r.name)}  code=${r.has_code}`
        );
      } catch (err) {
        mismatches += 1;
        console.log(`[${network}] ERROR    ${expKey.padEnd(10)} ${address}  ${err.shortMessage ?? err.message}`);
        summary[network].push({ expKey, address, error: err.shortMessage ?? err.message });
      }
    }
  }
  console.log("\n--- SUMMARY JSON ---");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nMismatches: ${mismatches}`);
  if (mismatches > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(2);
});
