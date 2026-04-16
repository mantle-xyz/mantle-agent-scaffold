import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(execFile);

const CLI_PATH = resolve("../../packages/cli/dist/index.js");

async function run(args) {
  try {
    const { stdout, stderr } = await execAsync("node", [CLI_PATH, ...args], {
      timeout: 20000,
      env: { ...process.env, NODE_OPTIONS: "--stack-trace-limit=50" },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message };
  }
}

console.log("CLI_PATH:", CLI_PATH);
console.log();

console.log("=== chain-info ===");
const r1 = await run(["--network", "mainnet", "--json", "chain-info"]);
console.log("exit:", r1.code);
console.log("stdout:", r1.stdout.slice(0, 300));
console.log("stderr:", r1.stderr.slice(0, 300));

console.log("\n=== lp positions --provider agni ===");
const r2 = await run(["--network", "mainnet", "--json", "lp", "positions", "--owner", "0xab5a413A2B0EB4bF451b3993E894796AD057f162", "--provider", "agni"]);
console.log("exit:", r2.code);
console.log("stdout:", r2.stdout.slice(0, 500));
console.log("stderr:", r2.stderr.slice(0, 500));

console.log("\n=== lp lb-positions ===");
const r3 = await run(["--network", "mainnet", "--json", "lp", "lb-positions", "--owner", "0xab5a413A2B0EB4bF451b3993E894796AD057f162"]);
console.log("exit:", r3.code);
console.log("stdout:", r3.stdout.slice(0, 500));
console.log("stderr:", r3.stderr.slice(0, 300));
