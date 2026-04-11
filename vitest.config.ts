import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Override workspace auto-detection — run all tests from root only.
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          environment: "node"
        }
      }
    ]
  }
});
