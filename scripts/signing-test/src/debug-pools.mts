import { createPublicClient, http, parseAbi } from "viem";

const rpc = "https://rpc.mantle.xyz";
const client = createPublicClient({ transport: http(rpc) });

// --- Agni WMNT/USDe pool fee tier ---
const AGNI_WMNT_USDE = "0xeafc4d6d4c3391cd4fc10c85d2f5f972d58c0dd5";
const V3_POOL_ABI = parseAbi([
  "function fee() view returns (uint24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function tickSpacing() view returns (int24)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16,uint16,uint16,uint8,bool)",
]);

const [fee, token0, token1, spacing, slot0] = await Promise.all([
  client.readContract({ address: AGNI_WMNT_USDE, abi: V3_POOL_ABI, functionName: "fee" }),
  client.readContract({ address: AGNI_WMNT_USDE, abi: V3_POOL_ABI, functionName: "token0" }),
  client.readContract({ address: AGNI_WMNT_USDE, abi: V3_POOL_ABI, functionName: "token1" }),
  client.readContract({ address: AGNI_WMNT_USDE, abi: V3_POOL_ABI, functionName: "tickSpacing" }),
  client.readContract({ address: AGNI_WMNT_USDE, abi: V3_POOL_ABI, functionName: "slot0" }),
]);

console.log("Agni WMNT/USDe pool:", AGNI_WMNT_USDE);
console.log("  fee:", Number(fee));
console.log("  tickSpacing:", Number(spacing));
console.log("  token0:", token0);
console.log("  token1:", token1);
console.log("  current tick:", slot0[1]);

// --- Moe LB pair active_ids ---
const LB_ABI = parseAbi([
  "function getActiveId() view returns (uint24)",
  "function getTokenX() view returns (address)",
  "function getTokenY() view returns (address)",
]);

const pairs = [
  { label: "Moe WMNT/USDT (bin_step=15)", addr: "0xf6C9020c9E915808481757779EDB53DACEaE2415" },
  { label: "Moe WMNT/USDC (bin_step=25)", addr: "0xa1C653c415Db1c00dfd04eE26E624f959A0eD52F" },
  { label: "Moe WMNT/USDe (bin_step=25)", addr: "0x5d54d430D1FD9425976147318E6080479bffC16D" },
  { label: "Moe WMNT/USDT0 (bin_step=25)", addr: "0xC0729cDE19741dE280b230D650F0fDad2aD79D09" },
];

for (const p of pairs) {
  try {
    const [activeId, tokenX, tokenY] = await Promise.all([
      client.readContract({ address: p.addr, abi: LB_ABI, functionName: "getActiveId" }),
      client.readContract({ address: p.addr, abi: LB_ABI, functionName: "getTokenX" }),
      client.readContract({ address: p.addr, abi: LB_ABI, functionName: "getTokenY" }),
    ]);
    console.log(`\n${p.label}:`);
    console.log(`  activeId: ${Number(activeId)}`);
    console.log(`  tokenX: ${tokenX}`);
    console.log(`  tokenY: ${tokenY}`);
  } catch (err) {
    console.log(`\n${p.label}: ERROR — ${(err as Error).message.split("\n")[0]}`);
  }
}
