import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const FORBIDDEN = [
  "@dbos-inc/dbos-sdk",
  "drizzle-orm",
  "/server/harness/run-store.ts",
  "/server/harness/playwright-check.ts",
  "/server/harness/testing-child.ts",
  "/server/harness/testing-store.ts",
];

const PRELOAD = `
import { registerHooks } from "node:module";

const forbidden = ${JSON.stringify(FORBIDDEN)};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const hit = forbidden.find(
      (name) => specifier === name || specifier.startsWith(name + "/") || resolved.url.endsWith(name),
    );

    if (hit) {
      throw new Error("Forbidden module loaded: " + hit);
    }

    return resolved;
  },
});
`;

const SCRIPT = `
await import(process.env.PLANNER_MODULE_URL);
console.log("planner-import-ok");
`;

test("importing the standalone planner loads no DBOS, database, browser, or child module", async () => {
  const directory = await mkdtemp(join(tmpdir(), "planner-import-"));

  try {
    const preload = join(directory, "preload.mjs");
    const script = join(directory, "script.mjs");
    await writeFile(preload, PRELOAD);
    await writeFile(script, SCRIPT);
    const { MODEL_API_KEY: _ignored, ...environment } = process.env;
    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preload).href, "--import", "tsx", script],
      {
        cwd: PROJECT_ROOT,
        timeout: 30_000,
        env: {
          ...environment,
          PLANNER_MODULE_URL: pathToFileURL(join(PROJECT_ROOT, "server/harness/planner.ts")).href,
        },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /planner-import-ok/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
