import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executionFiles } from "./file-policy.mjs";

const testsDir = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

const files = executionFiles(projectRoot, process.argv.slice(2));

if (files.length === 0) {
  throw new Error("No tests found");
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
  cwd: projectRoot,
  env: { ...process.env, TSX_TSCONFIG_PATH: join(testsDir, "tsconfig.json") },
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
