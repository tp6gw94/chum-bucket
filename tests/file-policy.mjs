import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const SOURCE_ROOTS = ["server", "shared", "src", "components", "lib", "scripts"];
export const ENTRY_FILES = ["vite.config.js", "drizzle.config.ts"];

const COMMON_SKIPPED_DIRECTORIES = new Set(["node_modules", "dist"]);
const TEST_SKIPPED_DIRECTORIES = new Set([...COMMON_SKIPPED_DIRECTORIES, "coverage"]);
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const EXECUTABLE_TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const TEST_ONLY_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

export function classifyFile(projectRelativePath) {
  const path = projectRelativePath.replace(/\\/g, "/");
  const underTests = path.startsWith("tests/") || path.includes("/tests/");

  return {
    execution: EXECUTABLE_TEST_FILE.test(path) ? "test" : "not-test",
    boundary: underTests || TEST_ONLY_FILE.test(path) ? "test-only" : "production",
  };
}

function walk(directory, accept, skippedDirectories) {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);

    if (entry.isDirectory()) {
      return skippedDirectories.has(entry.name) ? [] : walk(full, accept, skippedDirectories);
    }

    return accept(entry) ? [full] : [];
  });
}

function isSourceFile(entry) {
  return (entry.isFile() || entry.isSymbolicLink()) && SCRIPT_FILE.test(entry.name);
}

function isExecutableTest(entry) {
  return entry.isFile() && classifyFile(entry.name).execution === "test";
}

export function listSourceFiles(projectRoot) {
  const files = SOURCE_ROOTS.flatMap((root) =>
    walk(join(projectRoot, root), isSourceFile, COMMON_SKIPPED_DIRECTORIES),
  );
  const entries = ENTRY_FILES.map((entry) => join(projectRoot, entry)).filter((file) =>
    existsSync(file),
  );

  return [...files, ...entries];
}

export function discoverTests(projectRoot) {
  return [...SOURCE_ROOTS, "tests"]
    .flatMap((root) => walk(join(projectRoot, root), isExecutableTest, TEST_SKIPPED_DIRECTORIES))
    .sort();
}

export function executionFiles(projectRoot, explicitPaths) {
  if (explicitPaths.some((token) => token.startsWith("-"))) {
    return explicitPaths;
  }

  const requested = explicitPaths.length > 0 ? explicitPaths : discoverTests(projectRoot);
  const seen = new Set();

  return requested.filter((file) => {
    const absolute = resolve(projectRoot, file);

    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      return true;
    }

    const identity = realpathSync.native(absolute);

    if (seen.has(identity)) {
      return false;
    }

    seen.add(identity);

    return true;
  });
}
