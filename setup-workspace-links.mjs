import { symlinkSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

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
  console.log(`created: ${dst} -> ${src}`);
}
