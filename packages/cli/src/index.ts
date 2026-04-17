#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { MantleMcpError, toErrorPayload } from "@mantleio/mantle-core/errors.js";
import { disableColors, formatError, formatJson } from "./formatter.js";
import { applyRpcOverride } from "./utils.js";
import { registerChain } from "./commands/chain.js";
import { registerRegistry } from "./commands/registry.js";
import { registerAccount } from "./commands/account.js";
import { registerToken } from "./commands/token.js";
import { registerDefi } from "./commands/defi.js";
import { registerSwap } from "./commands/defi-swap.js";
import { registerApprove } from "./commands/defi-approve.js";
import { registerAave } from "./commands/defi-aave.js";
import { registerLp } from "./commands/defi-lp.js";
import { registerIndexer } from "./commands/indexer.js";
import { registerDiagnostics } from "./commands/diagnostics.js";
import { registerCatalog } from "./commands/catalog.js";
import { registerUtils } from "./commands/utils.js";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
);

const program = new Command();

program
  .name("mantle-cli")
  .description("CLI for Mantle L2 chain reads, DeFi queries, swaps, LP, and Aave operations")
  .version(pkg.version)
  .option("-n, --network <network>", "target network (mainnet, sepolia)", "mainnet")
  .option("--json", "output raw JSON", false)
  .option("--no-color", "disable colored output")
  .option("--rpc-url <url>", "override RPC endpoint")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.color === false) {
      disableColors();
    }
    applyRpcOverride(opts.rpcUrl, opts.network);
  });

registerChain(program);
registerRegistry(program);
registerAccount(program);
registerToken(program);
registerDefi(program);
registerSwap(program);
registerApprove(program);
registerAave(program);
registerLp(program);
registerIndexer(program);
registerDiagnostics(program);
registerCatalog(program);
registerUtils(program);

program.parseAsync(process.argv).catch((error) => {
  const globals = program.opts();
  if (error instanceof MantleMcpError) {
    const payload = toErrorPayload(error);
    if (globals.json) {
      formatJson(payload);
    } else {
      // In human-readable mode, print the stop instruction first if present
      if (payload._stop_instruction) {
        console.error(String(payload._stop_instruction));
      }
      formatError({ code: error.code, message: error.message, suggestion: error.suggestion });
      if (error.questionForUser) {
        console.error(`  Question: ${error.questionForUser}`);
      }
    }
    process.exit(1);
  }

  if (globals.json) {
    formatJson({
      error: true,
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
      suggestion: "Retry the operation or check server logs.",
      requires_user_input: false,
      retryable: false
    });
  } else {
    formatError({ message: error instanceof Error ? error.message : String(error) });
  }
  process.exit(2);
});
