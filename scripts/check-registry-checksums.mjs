#!/usr/bin/env node
// Sanity-check that every registry.json contract address is EIP-55 checksummed.
// Prints any entry whose stored form differs from viem's getAddress() normalization.
import { getAddress } from "viem";
import { readFileSync } from "node:fs";

const data = JSON.parse(
  readFileSync(new URL("../packages/core/src/config/registry.json", import.meta.url), "utf8")
);

let bad = 0;
for (const entry of data.contracts) {
  try {
    const normalized = getAddress(entry.address);
    if (normalized !== entry.address) {
      bad += 1;
      console.log(`${entry.environment}/${entry.key}`);
      console.log(`  stored:     ${entry.address}`);
      console.log(`  normalized: ${normalized}`);
    }
  } catch (err) {
    bad += 1;
    console.log(`${entry.environment}/${entry.key} INVALID ADDRESS: ${entry.address} (${err.message})`);
  }
}
console.log(`\nEntries with non-checksummed / invalid addresses: ${bad}`);
process.exit(bad > 0 ? 1 : 0);
