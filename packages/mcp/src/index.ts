#!/usr/bin/env node

async function main() {
  const { runServer } = await import("./server.js");
  await runServer();
}

main().catch((error) => {
  // stderr logging only, so MCP stdio payload remains clean.
  console.error("Fatal:", error);
  process.exit(1);
});
