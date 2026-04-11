import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("readme landing page", () => {
  it("keeps the root README organized around install, tools, workflow, and safety", () => {
    const readme = readFileSync("README.md", "utf8");

    expect(readme).toContain("# mantle-agent-scaffold");
    expect(readme).toContain("## Install as MCP Server");
    expect(readme).toContain("## Available Tools");
    expect(readme).toContain("## DeFi Workflow");
    expect(readme).toContain("## Safety Rules");
    expect(readme).toContain("## Skills");
    expect(readme).toContain("## Local Development");
    expect(readme).toContain("## CLI");
    expect(readme).toContain("## Documentation");

    expect(readme).not.toContain("## Implemented Surface");
    expect(readme).not.toContain("## DeFi Data Source Strategy");
    expect(readme).not.toContain("## External Agents: Required Usage Contract");
    expect(readme).not.toContain("## URL and Interface Quick Reference");
    expect(readme).not.toContain("## E2E Agent Test");
  });

  it("points readers to the docs site and package READMEs for detailed guidance", () => {
    const readme = readFileSync("README.md", "utf8");

    expect(readme).toContain("/concepts/external-agents");
    expect(readme).toContain("/concepts/skills");
    expect(readme).toContain("https://mantle-xyz.github.io/mantle-agent-scaffold/");
    expect(readme).toContain("packages/core/README.md");
    expect(readme).toContain("packages/cli/README.md");
    expect(readme).toContain("packages/mcp/README.md");
  });
});
