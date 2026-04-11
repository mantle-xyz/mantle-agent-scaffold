import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("cli layout", () => {
  it("publishes the CLI from the packages/cli directory", () => {
    const packageJson = JSON.parse(readFileSync("packages/cli/package.json", "utf8")) as {
      bin?: Record<string, string>;
      files?: string[];
    };

    expect(packageJson.bin?.["mantle-cli"]).toBe("dist/index.js");
    expect(packageJson.files).toContain("dist");
    expect(existsSync("packages/cli/src/index.ts")).toBe(true);
    expect(existsSync("packages/cli/src/utils.ts")).toBe(true);
  });
});
