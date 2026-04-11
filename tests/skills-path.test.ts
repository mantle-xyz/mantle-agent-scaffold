import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSkillsReference, isSkillsCheckoutAvailable } from "@0xwh1sker/mantle-mcp/lib/skills-path.js";

describe("readSkillsReference", () => {
  it("tells the operator how to initialize the skills checkout when it is missing", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "skills-missing-"));

    try {
      expect(() =>
        readSkillsReference("skills/mantle-network-primer/references/mantle-network-basics.md", tempDir)
      ).toThrow(/npm run skills:init/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reads from the nested skills tree exposed by the canonical submodule", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "skills-nested-"));
    const nestedDir = path.join(
      tempDir,
      "skills",
      "skills",
      "mantle-network-primer",
      "references"
    );

    try {
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(
        path.join(nestedDir, "mantle-network-basics.md"),
        "# Mantle Network Basics\n\nNested layout.\n"
      );

      expect(
        readSkillsReference("skills/mantle-network-primer/references/mantle-network-basics.md", tempDir)
      ).toContain("Mantle Network Basics");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("isSkillsCheckoutAvailable", () => {
  it("returns false when skills/ does not exist", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "no-skills-"));
    try {
      expect(isSkillsCheckoutAvailable(tempDir)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns true when skills/ exists", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "has-skills-"));
    try {
      mkdirSync(path.join(tempDir, "skills"));
      expect(isSkillsCheckoutAvailable(tempDir)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
