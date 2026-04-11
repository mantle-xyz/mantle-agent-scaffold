import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("open source readiness", () => {
  it("includes baseline community health files", () => {
    const expectedFiles = [
      "CONTRIBUTING.md",
      "CODE_OF_CONDUCT.md",
      "SECURITY.md",
      "SUPPORT.md",
      ".github/pull_request_template.md",
      ".github/ISSUE_TEMPLATE/bug_report.md",
      ".github/ISSUE_TEMPLATE/feature_request.md"
    ];

    for (const file of expectedFiles) {
      expect(existsSync(file), `${file} should exist`).toBe(true);
    }
  });

  it("includes ci workflow for build, tests, docs, and skills init", () => {
    expect(existsSync(".github/workflows/ci.yml")).toBe(true);

    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("git submodule update --init --recursive skills");
    expect(workflow).toContain("npm run build");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain("npm run docs:build");
  });
});
