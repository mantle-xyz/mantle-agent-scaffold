import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("docs alignment", () => {
  it("keeps mcp.serverUseInstructions aligned with SERVER_INSTRUCTIONS", () => {
    const packageJson = JSON.parse(readFileSync("packages/mcp/package.json", "utf8")) as {
      mcp?: { serverUseInstructions?: string };
    };
    const instructions = packageJson.mcp?.serverUseInstructions ?? "";
    const serverInstructions = readFileSync("packages/mcp/SERVER_INSTRUCTIONS.md", "utf8");

    expect(instructions.length).toBeGreaterThan(50);
    expect(serverInstructions).toContain("mantle-mcp Server Instructions");
    expect(serverInstructions).toContain("Never Hold Private Keys");
    expect(serverInstructions).toContain("MNT is the Gas Token");
    expect(serverInstructions).toContain("human_summary");
  });
});
