import type { Command } from "commander";
import { capabilityCatalog, type CapabilityEntry } from "@0xwh1sker/mantle-core/capability-catalog.js";
import { formatTable, formatJson } from "../formatter.js";

export function registerCatalog(parent: Command): void {
  const group = parent.command("catalog").description("Capability catalog — discover available tools, their categories, and usage");

  group
    .command("list")
    .description("List all capabilities with category, auth requirement, and summary")
    .option("--category <cat>", "filter by category: query, analyze, or execute")
    .option("--auth <auth>", "filter by auth requirement: none, optional, or required")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const catalog = capabilityCatalog();
      let caps = catalog.capabilities;

      if (opts.category) {
        caps = caps.filter((c) => c.category === opts.category);
      }
      if (opts.auth) {
        caps = caps.filter((c) => c.auth === opts.auth);
      }

      if (globals.json) {
        formatJson({ version: catalog.version, capabilities: caps });
      } else {
        formatTable(caps as unknown as Record<string, unknown>[], [
          { key: "id", label: "Tool ID" },
          { key: "category", label: "Category" },
          { key: "auth", label: "Auth" },
          { key: "summary", label: "Summary" }
        ]);
      }
    });

  group
    .command("search")
    .description("Search capabilities by keyword (matches id, name, summary, and tags)")
    .argument("<keyword>", "keyword to search for")
    .action(async (keyword: string, _opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const catalog = capabilityCatalog();
      const kw = keyword.toLowerCase();

      const matches = catalog.capabilities.filter((c) =>
        c.id.toLowerCase().includes(kw) ||
        c.name.toLowerCase().includes(kw) ||
        c.summary.toLowerCase().includes(kw) ||
        c.tags.some((t) => t.toLowerCase().includes(kw))
      );

      if (globals.json) {
        formatJson({ query: keyword, matches });
      } else {
        if (matches.length === 0) {
          console.log(`\n  No capabilities matching "${keyword}".\n`);
        } else {
          formatTable(matches as unknown as Record<string, unknown>[], [
            { key: "id", label: "Tool ID" },
            { key: "category", label: "Category" },
            { key: "auth", label: "Auth" },
            { key: "summary", label: "Summary" }
          ]);
        }
      }
    });

  group
    .command("show")
    .description("Show full details for a specific capability by tool ID")
    .argument("<tool-id>", "tool ID (e.g. mantle_buildSwap)")
    .action(async (toolId: string, _opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const catalog = capabilityCatalog();
      const cap = catalog.capabilities.find(
        (c) => c.id === toolId || c.id.toLowerCase() === toolId.toLowerCase()
      );

      if (!cap) {
        console.error(`\n  Capability "${toolId}" not found. Use 'catalog list' to see all.\n`);
        process.exit(1);
      }

      if (globals.json) {
        formatJson(cap);
      } else {
        console.log();
        console.log(`  ID:           ${cap.id}`);
        console.log(`  Name:         ${cap.name}`);
        console.log(`  Category:     ${cap.category}`);
        console.log(`  Mutates:      ${cap.mutates}`);
        console.log(`  Auth:         ${cap.auth}`);
        console.log(`  Summary:      ${cap.summary}`);
        console.log(`  CLI:          ${cap.cli_command}`);
        if (cap.workflow_before && cap.workflow_before.length > 0) {
          console.log(`  Before:       ${cap.workflow_before.join(", ")}`);
        }
        console.log(`  Tags:         ${cap.tags.join(", ")}`);
        console.log();
      }
    });
}
