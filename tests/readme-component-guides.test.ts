import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("component readmes", () => {
  it("documents the core library in packages/core/README.md", () => {
    expect(existsSync("packages/core/README.md")).toBe(true);

    const readme = readFileSync("packages/core/README.md", "utf8");
    expect(readme).toContain("# @0xwh1sker/mantle-core");
    expect(readme).toContain("tools/");
    expect(readme).toContain("lib/");
    expect(readme).toContain("config/");
  });

  it("documents the CLI in packages/cli/README.md", () => {
    expect(existsSync("packages/cli/README.md")).toBe(true);

    const readme = readFileSync("packages/cli/README.md", "utf8");
    expect(readme).toContain("# @0xwh1sker/mantle-cli");
    expect(readme).toContain("mantle-cli");
    expect(readme).toContain("catalog list --json");
    expect(readme).toContain("catalog search");
    expect(readme).toContain("chain info");
    expect(readme).toContain("registry resolve");
  });

  it("documents the MCP server in packages/mcp/README.md", () => {
    expect(existsSync("packages/mcp/README.md")).toBe(true);

    const readme = readFileSync("packages/mcp/README.md", "utf8");
    expect(readme).toContain("# @0xwh1sker/mantle-mcp");
    expect(readme).toContain("mantle-mcp");
  });
});
