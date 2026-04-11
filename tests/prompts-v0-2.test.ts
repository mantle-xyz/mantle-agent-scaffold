import { describe, expect, it } from "vitest";
import { getPromptMessages, prompts } from "@0xwh1sker/mantle-mcp/prompts.js";

describe("v0.2 prompts", () => {
  it("registers mantle_portfolioAudit, mantle_mantleBasics, and mantle_gasConfiguration", () => {
    const names = prompts.map((prompt) => prompt.name).sort();
    expect(names).toEqual([
      "mantle_gasConfiguration",
      "mantle_mantleBasics",
      "mantle_portfolioAudit"
    ]);
  });

  it("uses CRITICAL gas prompt description", () => {
    const gasPrompt = prompts.find((prompt) => prompt.name === "mantle_gasConfiguration");
    expect(gasPrompt).toBeDefined();
    expect(gasPrompt!.description.startsWith("CRITICAL:")).toBe(true);
  });

  it("returns prompt message payloads with detailed workflow content", () => {
    const portfolio = getPromptMessages("mantle_portfolioAudit");
    const basics = getPromptMessages("mantle_mantleBasics");
    const gas = getPromptMessages("mantle_gasConfiguration");

    expect(portfolio).not.toBeNull();
    expect(basics).not.toBeNull();
    expect(gas).not.toBeNull();

    expect(portfolio![1].content.text).toContain("Mantle Portfolio Audit Workflow");
    expect(portfolio![1].content.text).toContain("## Common Mistakes");
    expect(portfolio![1].content.text).toContain("Risk Level");

    expect(basics![1].content.text).toContain("Mantle Network Fundamentals");
    expect(basics![1].content.text).toContain("## Architecture");
    expect(basics![1].content.text).toContain("## DeFi Landscape");

    expect(gas![1].content.text).toContain("Mantle Gas Configuration");
    expect(gas![1].content.text).toContain("## CRITICAL: Gas Token is MNT, Not ETH");
    expect(gas![1].content.text).toContain("## Gas Costs (Very Cheap)");
    expect(gas![1].content.text).toContain("## Common Mistakes");
  });
});
