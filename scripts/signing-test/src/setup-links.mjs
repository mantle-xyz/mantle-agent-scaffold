import { symlinkSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Run from the worktree root (parent of scripts/signing-test)
// When invoked as `npm run setup:links` from scripts/signing-test, cwd is there.
// We need to normalize to worktree root.
process.chdir(resolve("../.."));

const root = process.cwd();
console.log(`worktree root: ${root}`);

mkdirSync("node_modules/@mantleio", { recursive: true });

const links = [
  ["packages/core", "node_modules/@mantleio/mantle-core"],
  ["packages/cli",  "node_modules/@mantleio/mantle-cli"],
  ["packages/mcp",  "node_modules/@mantleio/mantle-mcp"],
];

for (const [src, dst] of links) {
  const absDst = resolve(dst);
  if (existsSync(absDst)) {
    rmSync(absDst, { recursive: true, force: true });
  }
  symlinkSync(resolve(src), absDst, "dir");
  console.log(`  ${dst} -> ${src}`);
}
