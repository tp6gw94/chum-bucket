import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    "tests/server/harness/compaction.test.ts",
    "tests/server/harness/model-turn.test.ts",
    "tests/server/harness/run.test.ts",
  ],
  {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: {
      ...process.env,
      DATABASE_URL: "postgresql://offline:offline@127.0.0.1:1/offline",
      MODEL_API_KEY: "offline",
    },
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
