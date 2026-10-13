import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { classifyFile, discoverTests, executionFiles } from "./file-policy.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function withProject(files: readonly string[], run: (root: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "file-policy-"));

  try {
    for (const file of files) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), "");
    }

    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("test files are executable, spec files and tests/ support are test-only, the rest is production", () => {
  assert.deepEqual(classifyFile("server/harness/testing-checks.test.ts"), {
    execution: "test",
    boundary: "test-only",
  });
  assert.deepEqual(classifyFile("tests/server/run.test.mts"), {
    execution: "test",
    boundary: "test-only",
  });
  assert.deepEqual(classifyFile("server/run.spec.ts"), {
    execution: "not-test",
    boundary: "test-only",
  });
  assert.deepEqual(classifyFile("tests/fixtures/mcp-fixture.ts"), {
    execution: "not-test",
    boundary: "test-only",
  });
  assert.deepEqual(classifyFile("server/mcp-fixture.ts"), {
    execution: "not-test",
    boundary: "production",
  });
  assert.deepEqual(classifyFile("server\\harness\\run-store.ts"), {
    execution: "not-test",
    boundary: "production",
  });
});

test("default discovery lists colocated and centralized tests once in sorted order", () => {
  withProject(
    [
      "tests/b.test.ts",
      "tests/a.test.mjs",
      "tests/helper.ts",
      "tests/node_modules/dep/x.test.ts",
      "server/harness/colocated.test.ts",
      "server/harness/colocated.spec.ts",
      "server/harness/aliased.target.ts",
      "src/view.test.tsx",
      "dist/built.test.js",
      "server/coverage/report.test.ts",
    ],
    (root) => {
      symlinkSync(
        path.join(root, "server/harness/aliased.target.ts"),
        path.join(root, "server/harness/alias.test.ts"),
      );
      const expected = [
        "server/harness/colocated.test.ts",
        "src/view.test.tsx",
        "tests/a.test.mjs",
        "tests/b.test.ts",
      ].map((file) => path.join(root, file));
      assert.deepEqual(discoverTests(root), expected);
      assert.deepEqual(executionFiles(root, []), expected);
    },
  );
});

test("explicit paths keep their order and drop repeats of the same real file", () => {
  withProject(["tests/b.test.ts", "tests/a.test.ts"], (root) => {
    symlinkSync(path.join(root, "tests/a.test.ts"), path.join(root, "tests/link.test.ts"));
    assert.deepEqual(
      executionFiles(root, [
        "tests/b.test.ts",
        "tests/a.test.ts",
        "./tests/b.test.ts",
        "tests/link.test.ts",
        path.join(root, "tests/a.test.ts"),
      ]),
      ["tests/b.test.ts", "tests/a.test.ts"],
    );
  });
});

test("explicit non-files keep order and repeats of missing or directory paths", () => {
  withProject(["tests/a.test.ts"], (root) => {
    assert.deepEqual(
      executionFiles(root, [
        "tests/a.test.ts",
        "tests/a.test.ts",
        "missing.test.ts",
        "missing.test.ts",
        "tests",
      ]),
      ["tests/a.test.ts", "missing.test.ts", "missing.test.ts", "tests"],
    );
  });
});

test("explicit argv containing node options is forwarded unchanged", () => {
  withProject(["tests/a.test.ts", "tests/import.mjs"], (root) => {
    const argv = [
      "--test-reporter=spec",
      "--test-reporter=spec",
      "--import",
      "tests/import.mjs",
      "--import",
      "tests/import.mjs",
      "tests/a.test.ts",
      "tests/a.test.ts",
      "missing.test.ts",
    ];
    assert.deepEqual(executionFiles(root, argv), argv);
  });
});

test("runner accepts a repeated node option value that is an existing file", () => {
  const module = path.join(projectRoot, "tests/file-policy.mjs");
  const result = spawnSync(
    process.execPath,
    [
      path.join(projectRoot, "tests/runner.mjs"),
      "--import",
      module,
      "--import",
      module,
      "--test-name-pattern=checksForRole",
      path.join(projectRoot, "server/harness/testing-checks.test.ts"),
    ],
    { cwd: projectRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

function tscFiles(config: string): ReadonlySet<string> {
  const result = spawnSync(
    path.join(projectRoot, "node_modules/.bin/tsc"),
    ["-p", config, "--listFilesOnly"],
    { cwd: projectRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr);

  return new Set(result.stdout.split("\n").filter(Boolean));
}

test(
  "every discovered TypeScript test is part of a typechecked project",
  { timeout: 120_000 },
  () => {
    const checked = new Set([
      ...tscFiles(path.join(projectRoot, "tsconfig.json")),
      ...tscFiles(path.join(projectRoot, "tests/tsconfig.json")),
    ]);
    const uncovered = discoverTests(projectRoot).filter(
      (file) => /\.[cm]?tsx?$/.test(file) && !checked.has(file),
    );
    assert.deepEqual(uncovered, []);
  },
);
