import { runCli } from "./cli.js";

const owner = "0xab5a413A2B0EB4bF451b3993E894796AD057f162";

console.log("=== lp positions --provider agni ===");
const r1 = await runCli(["lp", "positions", "--owner", owner, "--provider", "agni"]);
console.log("exitCode:", r1.exitCode);
console.log("stdout:", r1.stdout);
console.log("stderr:", r1.stderr);

console.log("\n=== lp positions (no provider filter) ===");
const r2 = await runCli(["lp", "positions", "--owner", owner]);
console.log("exitCode:", r2.exitCode);
console.log("stdout:", r2.stdout.slice(0, 500));
console.log("stderr:", r2.stderr);
