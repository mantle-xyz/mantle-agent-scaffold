import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the monorepo root where the skills/ submodule lives.
 * Walk up from this module's compiled location until we find a directory
 * containing a skills/ folder or .gitmodules, falling back to cwd.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(): string {
  let dir = path.resolve(__dirname);
  const { root } = path.parse(dir);
  while (dir !== root) {
    if (existsSync(path.join(dir, "skills")) || existsSync(path.join(dir, ".gitmodules"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  // skills/ not found in any ancestor — likely running from an npm install
  // rather than the monorepo checkout.  Fall back to cwd but warn.
  console.error(
    "[mantle-mcp] Could not locate the skills/ submodule. " +
    "If running from the monorepo, run `npm run skills:init`. " +
    "Falling back to process.cwd()."
  );
  return process.cwd();
}

const REPO_ROOT = findRepoRoot();

/**
 * Check whether the skills submodule checkout is reachable.
 * Returns true when running inside the monorepo with skills initialized,
 * false for standalone npm consumers.
 */
export function isSkillsCheckoutAvailable(baseDir = REPO_ROOT): boolean {
  return existsSync(path.resolve(baseDir, "skills"));
}

export function readSkillsReference(relativePath: string, baseDir = REPO_ROOT): string {
  const absolutePath = path.resolve(baseDir, relativePath);

  if (existsSync(absolutePath)) {
    return readFileSync(absolutePath, "utf8");
  }

  const skillsRoot = path.resolve(baseDir, "skills");
  const nestedSkillsPath = path.resolve(baseDir, "skills", relativePath);

  if (existsSync(nestedSkillsPath)) {
    return readFileSync(nestedSkillsPath, "utf8");
  }

  if (!existsSync(skillsRoot)) {
    throw new Error(
      `Missing skills checkout at ${skillsRoot}. Run \`npm run skills:init\` to initialize the mantle-skills submodule.`
    );
  }

  throw new Error(`Missing skills reference file: ${relativePath}`);
}
