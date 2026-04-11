import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("version consistency", () => {
  it("aligns package, docs, server, and cli versions", () => {
    const rootJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      version: string;
    };
    const coreJson = JSON.parse(readFileSync("packages/core/package.json", "utf8")) as {
      version: string;
    };
    const cliJson = JSON.parse(readFileSync("packages/cli/package.json", "utf8")) as {
      version: string;
    };
    const mcpJson = JSON.parse(readFileSync("packages/mcp/package.json", "utf8")) as {
      version: string;
    };
    const docsJson = JSON.parse(readFileSync("docs/package.json", "utf8")) as {
      version: string;
    };
    const server = readFileSync("packages/mcp/src/server.ts", "utf8");
    const cli = readFileSync("packages/cli/src/index.ts", "utf8");
    const docsIndex = readFileSync("docs/content/index.mdx", "utf8");

    const v = rootJson.version;

    // all workspace packages track the same version
    expect(coreJson.version).toBe(v);
    expect(cliJson.version).toBe(v);
    expect(mcpJson.version).toBe(v);
    expect(docsJson.version).toBe(v);

    // server and cli read version dynamically from package.json
    expect(server).toContain("version: pkg.version");
    expect(cli).toContain(".version(pkg.version)");

    // docs index references the current version
    expect(docsIndex).toContain(`v${v}`);
  });

  it("keeps workspace package metadata aligned with package-lock", () => {
    const lockJson = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };

    const workspaces = [
      {
        manifestPath: "packages/core/package.json",
        lockPath: "packages/core"
      },
      {
        manifestPath: "packages/cli/package.json",
        lockPath: "packages/cli"
      },
      {
        manifestPath: "packages/mcp/package.json",
        lockPath: "packages/mcp"
      }
    ];

    for (const workspace of workspaces) {
      const manifest = JSON.parse(readFileSync(workspace.manifestPath, "utf8")) as {
        version: string;
        dependencies?: Record<string, string>;
      };
      const lockEntry = lockJson.packages[workspace.lockPath];

      expect(lockEntry?.version).toBe(manifest.version);
      expect(lockEntry?.dependencies ?? {}).toEqual(manifest.dependencies ?? {});
    }
  });
});
