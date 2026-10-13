import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkBoundaries } from "./check-boundaries.ts";

function withFixture(files: Record<string, string>, fn: (fixtureDir: string) => void) {
  const dir = path.join(
    "/tmp",
    `boundary-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  const localModules = path.join(dir, "node_modules");
  const repoModules = path.resolve(process.cwd(), "node_modules");

  if (fs.existsSync(repoModules)) {
    fs.symlinkSync(repoModules, localModules, "junction");
  }

  try {
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }

    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("repository obeys architecture and test separation boundaries", () => {
  const rootDir = fileURLToPath(new URL("../", import.meta.url));
  assert.deepEqual(checkBoundaries({ rootDir }).violations, []);
});

test("accepts colocated test files and skips production-only checks for them", () => {
  withFixture(
    {
      "server/service.ts": "export const s = 1;",
      "server/service.test.ts":
        "import test from 'node:test'; import pg from 'pg'; import * as store from './harness/testing-store.ts'; import { s } from './service.ts'; import '../tests/helper.ts'; test('s', () => s);",
      "server/harness/testing-store.ts": "export const x = 1;",
      "shared/contract.test.ts": "import { run } from '../server/harness/run-store.ts'; run();",
      "server/harness/run-store.ts": "export const run = () => {};",
      "tests/helper.ts": "export const helper = true;",
    },
    (dir) => {
      const res = checkBoundaries({ rootDir: dir });
      assert.deepEqual(res.violations, []);
      assert.strictEqual(res.ok, true);
    },
  );
});

test("production source symlinked to a file importing node:test is still checked", () => {
  withFixture(
    {
      "outside/service.ts": "import test from 'node:test'; export const run = test;",
    },
    (dir) => {
      fs.mkdirSync(path.join(dir, "server"));
      fs.symlinkSync(path.join(dir, "outside/service.ts"), path.join(dir, "server/service.ts"));
      const res = checkBoundaries({ rootDir: dir });
      assert.deepEqual(res.violations, [
        { rule: "prod-imports-test", file: "server/service.ts", detail: "node:test" },
      ]);
    },
  );
});

test("colocated spec files are test-only and still cannot be imported by production", () => {
  withFixture(
    {
      "server/service.ts": "import './service.spec.ts'; export const s = 1;",
      "server/service.spec.ts": "export const spec = true;",
    },
    (dir) => {
      const res = checkBoundaries({ rootDir: dir });
      assert.deepEqual(
        res.violations.map((v) => [v.rule, v.file]),
        [["prod-imports-test", "server/service.ts"]],
      );
    },
  );
});

test("rejects production importing a colocated test file or node:test", () => {
  withFixture(
    {
      "server/service.ts": "import './service.test.ts'; export const s = 1;",
      "server/service.test.ts": "export const t = true;",
      "server/runner.ts": "import test from 'node:test'; export const r = test;",
    },
    (dir) => {
      const res = checkBoundaries({ rootDir: dir });
      assert.deepEqual(res.violations.map((v) => [v.rule, v.file, v.detail]).sort(), [
        ["prod-imports-test", "server/runner.ts", "node:test"],
        ["prod-imports-test", "server/service.ts", "./service.test.ts"],
      ]);
    },
  );
});

test("production under a coverage directory is still checked", () => {
  withFixture(
    {
      "server/coverage/service.ts": "import test from 'node:test'; export const s = test;",
    },
    (dir) => {
      const res = checkBoundaries({ rootDir: dir });
      assert.deepEqual(
        res.violations.map((v) => [v.rule, v.file, v.detail]),
        [["prod-imports-test", "server/coverage/service.ts", "node:test"]],
      );
    },
  );
});

test("fixture-named production files get no test exemption", () => {
  withFixture(
    {
      "server/harness/testing-store.ts": "export function closeUnfinishedTesting() {};",
      "server/mcp-fixture.ts":
        "import * as store from './harness/testing-store.ts'; export const s = store;",
    },
    (dir) => {
      const res = checkBoundaries({ rootDir: dir });
      assert.ok(
        res.violations.some(
          (v) => v.file === "server/mcp-fixture.ts" && v.rule === "privileged-api-bypass",
        ),
      );
    },
  );
});

test("rejects production importing test files or test runner via relative path", () => {
  withFixture(
    {
      "server/service.ts": "import '../tests/helper.ts'; export const s = 1;",
      "tests/helper.ts": "export const helper = true;",
    },
    (dir) => {
      const res = checkBoundaries({ rootDir: dir });
      assert.strictEqual(res.ok, false);
      assert.ok(res.violations.some((v) => v.rule === "prod-imports-test"));
    },
  );
});

test("rejects production importing test runner node:test", () => {
  withFixture(
    {
      "server/service.ts": "import 'node:test'; export const s = 1;",
    },
    (dir) => {
      const res = checkBoundaries({ rootDir: dir });
      assert.strictEqual(res.ok, false);
      assert.ok(res.violations.some((v) => v.rule === "prod-imports-test"));
    },
  );
});

test("allows clean scaffold in testSeparationOnly mode but rejects couplings in full mode", () => {
  withFixture(
    {
      "server/testing.ts": "import './harness/run-store.ts'; export const route = 1;",
      "server/harness/run-store.ts": "export const runStore = 1;",
      "tests/service.test.ts": "export const ok = 1;",
    },
    (dir) => {
      const sep = checkBoundaries({ rootDir: dir, testSeparationOnly: true });
      assert.strictEqual(sep.ok, true);

      const full = checkBoundaries({ rootDir: dir, testSeparationOnly: false });
      assert.strictEqual(full.ok, false);
      assert.ok(full.violations.some((v) => v.rule === "route-imports-testing-internals"));
    },
  );
});

test("enforces domain transitive graph ban on db, dbos, runtime, and storage", () => {
  withFixture(
    {
      "shared/domain.ts": "import { helper } from './helper.ts'; export type Domain = helper;",
      "shared/helper.ts":
        "import type { DB } from '../server/db/index.ts'; export type helper = DB;",
      "server/db/index.ts": "export type DB = { id: string };",
    },
    (dir) => {
      const res = checkBoundaries({ rootDir: dir });
      assert.strictEqual(res.ok, false);
      assert.ok(res.violations.some((v) => v.rule === "domain-transitive-coupling"));
    },
  );
});

test("enforces domain transitive graph ban on pg and drizzle-orm subpaths", () => {
  withFixture(
    {
      "shared/domain.ts": "import type { PgType } from 'pg/types'; export type T = PgType;",
    },
    (dir) => {
      const res = checkBoundaries({ rootDir: dir });
      assert.strictEqual(res.ok, false);
      assert.ok(res.violations.some((v) => v.rule === "domain-transitive-coupling"));
    },
  );
});

test("enforces custom alias and type imports resolving to prohibited domain targets", () => {
  withFixture(
    {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@custom-alias/*": ["./server/*"] } },
      }),
      "server/harness/testing-domain.ts":
        "import type { X } from '@custom-alias/db/schema'; export type Policy = X;",
      "server/db/schema.ts": "export type X = string;",
    },
    (dir) => {
      const res = checkBoundaries({ rootDir: dir });
      assert.strictEqual(res.ok, false);
      assert.ok(res.violations.some((v) => v.rule === "domain-transitive-coupling"));
    },
  );
});

test("rejects run-store re-exporting testing-store journal symbols with local rename alias", () => {
  withFixture(
    {
      "server/harness/run-store.ts": `
        import { ackDelivery as localAck } from './testing-store.ts';
        export { localAck };
      `,
      "server/harness/testing-store.ts": "export const ackDelivery = () => {};",
    },
    (dir) => {
      const res = checkBoundaries({ rootDir: dir });
      assert.strictEqual(res.ok, false);
      assert.ok(res.violations.some((v) => v.rule === "run-store-journal-reexport"));
    },
  );
});

test("privileged parent transaction API allows only server/harness/run-store.ts and tests", () => {
  withFixture(
    {
      "server/harness/testing-store.ts":
        "export function findStandaloneAdmission() {}; export function commitInTransaction() {};",
      "server/harness/run-store.ts":
        "import { findStandaloneAdmission, commitInTransaction } from './testing-store.ts';",
      "server/harness/testing-child.ts":
        "import { findStandaloneAdmission } from './testing-store.ts';",
      "server/other-run-store.ts":
        "import { findStandaloneAdmission } from './harness/testing-store.ts';",
      "tests/whitebox.test.ts":
        "import { commitInTransaction } from '../server/harness/testing-store.ts';",
    },
    (dir) => {
      const res = checkBoundaries({ rootDir: dir });
      assert.strictEqual(res.ok, false);
      assert.ok(
        res.violations.some(
          (v) =>
            v.file === "server/harness/testing-child.ts" &&
            v.rule === "privileged-api-owner-violation",
        ),
      );
      assert.ok(
        res.violations.some(
          (v) =>
            v.file === "server/other-run-store.ts" && v.rule === "privileged-api-owner-violation",
        ),
      );
      assert.ok(!res.violations.some((v) => v.file === "server/harness/run-store.ts"));
      assert.ok(!res.violations.some((v) => v.file.includes("whitebox.test.ts")));
    },
  );
});

test("cancellation selection is importable by the run-store owner only", () => {
  withFixture(
    {
      "server/harness/testing-store.ts": "export async function selectTestingCancellation() {}",
      "server/harness/run-store.ts":
        "import { selectTestingCancellation } from './testing-store.ts'; export const cancel = selectTestingCancellation;",
      "server/harness/testing-run.ts":
        "import { selectTestingCancellation } from './testing-store.ts'; export const select = () => selectTestingCancellation();",
    },
    (dir) => {
      const res = checkBoundaries({ rootDir: dir });
      assert.ok(
        res.violations.some(
          (v) =>
            v.file === "server/harness/testing-run.ts" &&
            v.rule === "privileged-api-owner-violation" &&
            v.detail === "selectTestingCancellation",
        ),
      );
      assert.ok(
        !res.violations.some(
          (v) =>
            v.file === "server/harness/run-store.ts" && v.rule === "privileged-api-owner-violation",
        ),
      );
    },
  );
});

test("privileged parent API rejects namespace, default, dynamic, and require bypasses in non-owners", () => {
  withFixture(
    {
      "server/harness/testing-store.ts": "export function closeUnfinishedTesting() {};",
      "server/harness/testing-child.ts": "import * as store from './testing-store.ts';",
      "server/harness/testing-run.ts": "const store = require('./testing-store.ts');",
    },
    (dir) => {
      const res = checkBoundaries({ rootDir: dir });
      assert.strictEqual(res.ok, false);
      const childV = res.violations.filter((v) => v.file === "server/harness/testing-child.ts");
      assert.ok(childV.some((v) => v.rule === "privileged-api-bypass"));
      const runV = res.violations.filter((v) => v.file === "server/harness/testing-run.ts");
      assert.ok(runV.some((v) => v.rule === "privileged-api-bypass"));
    },
  );
});

test("detects dynamic import and createRequire aliases pointing to test code", () => {
  withFixture(
    {
      "server/service.ts": `
        import { createRequire } from 'module';
        const req = createRequire(import.meta.url);
        req('../tests/spec.ts');
      `,
      "tests/spec.ts": "export const x = 1;",
    },
    (dir) => {
      const res = checkBoundaries({ rootDir: dir });
      assert.strictEqual(res.ok, false);
      assert.ok(res.violations.some((v) => v.rule === "prod-imports-test"));
    },
  );
});

test("rejects all non-literal dynamic module loads", () => {
  withFixture(
    {
      "server/service.ts": "const mod = 'fs'; import(mod);",
    },
    (dir) => {
      const res = checkBoundaries({ rootDir: dir });
      assert.strictEqual(res.ok, false);
      assert.ok(res.violations.some((v) => v.rule === "non-literal-module-load"));
    },
  );
});

test("renamed inline exports and non-owner barrels cannot leak journal authority", () => {
  withFixture(
    {
      "server/harness/testing-store.ts":
        "export const ackDelivery = () => {}; export const closeInTransaction = () => {};",
      "server/harness/run-store.ts":
        "import { ackDelivery as local } from './testing-store'; export { local as renamed };",
      "server/barrel.ts": "export { closeInTransaction as commit } from './harness/testing-store';",
    },
    (dir) => {
      const result = checkBoundaries({ rootDir: dir });
      assert.ok(
        result.violations.some(
          (violation) =>
            violation.file === "server/harness/run-store.ts" &&
            violation.rule === "run-store-journal-reexport",
        ),
      );
      assert.ok(
        result.violations.some(
          (violation) =>
            violation.file === "server/barrel.ts" && violation.rule === "privileged-api-bypass",
        ),
      );
    },
  );
});

test("renamed, namespace and immediate createRequire loaders retain test boundaries", () => {
  for (const source of [
    "import { createRequire as make } from 'node:module'; const load = make(import.meta.url); load('../tests/helper.ts');",
    "import * as mod from 'node:module'; const load = mod.createRequire(import.meta.url); load('../tests/helper.ts');",
    "import { createRequire } from 'node:module'; createRequire(import.meta.url)(`../tests/helper.ts`);",
    "import(`../tests/helper.ts`);",
  ]) {
    withFixture(
      { "server/service.ts": source, "tests/helper.ts": "export const helper = true;" },
      (dir) => {
        assert.ok(
          checkBoundaries({ rootDir: dir }).violations.some(
            (violation) => violation.rule === "prod-imports-test",
          ),
        );
      },
    );
  }
});

test("a similarly named module cannot substitute for the testing facade", () => {
  withFixture(
    {
      "server/testing.ts": "import './harness/fake-testing-service';",
      "server/harness/fake-testing-service.ts": "export const fake = true;",
    },
    (dir) => {
      assert.ok(
        checkBoundaries({ rootDir: dir }).violations.some(
          (violation) => violation.rule === "route-imports-testing-internals",
        ),
      );
    },
  );
});

test("pure policy type imports and unscanned local bridges cannot evade the gate", () => {
  withFixture(
    {
      "server/harness/testing-policy.ts": "import type { Execution } from './testing-store';",
      "server/harness/testing-store.ts": "export type Execution = string;",
      "shared/domain.ts": "import '../outside';",
      "outside.ts": "import 'pg';",
    },
    (dir) => {
      const result = checkBoundaries({ rootDir: dir });
      assert.ok(
        result.violations.some(
          (violation) =>
            violation.file === "server/harness/testing-policy.ts" &&
            violation.rule === "domain-transitive-coupling",
        ),
      );
      assert.ok(
        result.violations.some(
          (violation) =>
            violation.file === "shared/domain.ts" &&
            violation.rule === "uncontrolled-source-target",
        ),
      );
    },
  );
});

test("import type expressions expose public snapshots but not parent transaction APIs", () => {
  withFixture(
    {
      "server/harness/testing-store.ts":
        "export type Execution = string; export const commitInTransaction = () => {};",
      "server/public.ts": "export type Snapshot = import('./harness/testing-store').Execution;",
      "server/private.ts":
        "export type Commit = typeof import('./harness/testing-store').commitInTransaction;",
    },
    (dir) => {
      const result = checkBoundaries({ rootDir: dir });
      assert.ok(
        result.violations.some(
          (violation) =>
            violation.file === "server/private.ts" &&
            violation.rule === "privileged-api-owner-violation",
        ),
      );
      assert.ok(!result.violations.some((violation) => violation.file === "server/public.ts"));
    },
  );
});

test("forwarding declarations cannot disguise journal re-exports", () => {
  for (const source of [
    "import { ackDelivery } from './testing-store'; export const acknowledge = ackDelivery;",
    "import { ackDelivery } from './testing-store'; export const acknowledge = (...args) => ackDelivery(...args);",
    "import { ackDelivery } from './testing-store'; export async function acknowledge(...args) { return await ackDelivery(...args); }",
    "import * as store from './testing-store'; export const acknowledge = store.ackDelivery;",
    "import type { TestingExecution } from './testing-store'; export type Snapshot = TestingExecution;",
  ]) {
    withFixture(
      {
        "server/harness/run-store.ts": source,
        "server/harness/testing-store.ts":
          "export const ackDelivery = (...args) => args; export type TestingExecution = string;",
      },
      (dir) => {
        assert.ok(
          checkBoundaries({ rootDir: dir }).violations.some(
            (violation) => violation.rule === "run-store-journal-reexport",
          ),
        );
      },
    );
  }
});

test("pure reachability remains transitive through non-domain bridge modules", () => {
  withFixture(
    {
      "server/harness/testing-policy.ts": "import './bridge';",
      "server/harness/bridge.ts": "import '../db/schema';",
      "server/db/schema.ts": "export const schema = {};",
    },
    (dir) => {
      assert.ok(
        checkBoundaries({ rootDir: dir }).violations.some(
          (violation) =>
            violation.file === "server/harness/testing-policy.ts" &&
            violation.rule === "domain-transitive-coupling",
        ),
      );
    },
  );
});

test("application build and database configuration entrypoints retain production boundaries", () => {
  for (const entry of ["vite.config.js", "drizzle.config.ts"]) {
    withFixture(
      {
        [entry]: "import './tests/helper.ts';",
        "tests/helper.ts": "export const helper = true;",
      },
      (dir) => {
        assert.ok(
          checkBoundaries({ rootDir: dir }).violations.some(
            (violation) => violation.file === entry && violation.rule === "prod-imports-test",
          ),
        );
      },
    );
  }
});

test("multi-stage local aliases cannot restore journal forwarding", () => {
  for (const forwarding of [
    "const first = ackDelivery; export { first as acknowledge };",
    "const first = ackDelivery; const second = first; export { second as acknowledge };",
    "function first(...args) { ackDelivery(...args); } export { first as acknowledge };",
  ]) {
    withFixture(
      {
        "server/harness/run-store.ts": `import { ackDelivery } from "./testing-store"; ${forwarding}`,
        "server/harness/testing-store.ts": "export const ackDelivery = (...args) => args;",
      },
      (dir) => {
        assert.ok(
          checkBoundaries({ rootDir: dir }).violations.some(
            (violation) => violation.rule === "run-store-journal-reexport",
          ),
        );
      },
    );
  }
});

test("owner journal value imports are structurally denied while transaction, error, and type imports stay legal", () => {
  withFixture(
    {
      "server/harness/testing-store.ts":
        "export const ackDelivery = () => {}; export function admitAttachedInTransaction() {} export class TestingPersistenceError extends Error {} export type TestingExecution = string;",
      "server/harness/run-store.ts": "import { ackDelivery } from './testing-store';",
    },
    (dir) => {
      assert.ok(
        checkBoundaries({ rootDir: dir }).violations.some(
          (violation) =>
            violation.file === "server/harness/run-store.ts" &&
            violation.rule === "run-store-journal-reexport",
        ),
      );
    },
  );

  withFixture(
    {
      "server/harness/testing-store.ts":
        "export function admitAttachedInTransaction() {} export class TestingPersistenceError extends Error {} export type TestingExecution = string;",
      "server/harness/run-store.ts": `
        import {
          admitAttachedInTransaction,
          TestingPersistenceError,
          type TestingExecution,
        } from './testing-store';
        export const use = (value: TestingExecution) => [
          admitAttachedInTransaction,
          TestingPersistenceError,
          value,
        ];
      `,
    },
    (dir) => {
      const result = checkBoundaries({ rootDir: dir });
      assert.ok(
        !result.violations.some((violation) => violation.file === "server/harness/run-store.ts"),
      );
    },
  );

  for (const source of [
    "import * as store from './testing-store';",
    "import store from './testing-store';",
    "const store = require('./testing-store');",
    "const store = await import('./testing-store');",
  ]) {
    withFixture(
      {
        "server/harness/testing-store.ts":
          "export const ackDelivery = () => {}; export default {};",
        "server/harness/run-store.ts": source,
      },
      (dir) => {
        assert.ok(
          checkBoundaries({ rootDir: dir }).violations.some(
            (violation) =>
              violation.file === "server/harness/run-store.ts" &&
              violation.rule === "run-store-journal-reexport",
          ),
        );
      },
    );
  }

  withFixture(
    {
      "server/harness/testing-store.ts": "export type TestingExecution = string;",
      "server/harness/run-store.ts":
        "import type * as store from './testing-store'; export type Snapshot = store.TestingExecution;",
    },
    (dir) => {
      const result = checkBoundaries({ rootDir: dir });
      assert.ok(
        !result.violations.some((violation) => violation.file === "server/harness/run-store.ts"),
      );
    },
  );
});

test("CLI exit outcomes: exits 1 on violations and exits 0 on clean code", () => {
  const cliPath = fileURLToPath(new URL("./check-boundaries.ts", import.meta.url));
  withFixture(
    {
      "server/a.ts": "import 'node:test';",
    },
    (dir) => {
      const failRun = spawnSync("node", ["--import", "tsx", cliPath], {
        cwd: dir,
        encoding: "utf-8",
      });
      assert.strictEqual(failRun.status, 1);
    },
  );

  withFixture(
    {
      "server/a.ts": "export const a = 1;",
    },
    (dir) => {
      const passRun = spawnSync("node", ["--import", "tsx", cliPath], {
        cwd: dir,
        encoding: "utf-8",
      });
      assert.strictEqual(passRun.status, 0);
    },
  );
});
