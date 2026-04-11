import { describe, expect, it } from "vitest";
import { allTools } from "@0xwh1sker/mantle-core/tools/index.js";

describe("tool descriptions", () => {
  it("includes concrete Examples and validates full address formatting when present", () => {
    const tools = Object.values(allTools);
    for (const tool of tools) {
      expect(tool.description).toContain("Examples:");

      const addresses = tool.description.match(/0x[a-fA-F0-9]+/g) ?? [];
      for (const address of addresses) {
        expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      }
    }
  });
});
