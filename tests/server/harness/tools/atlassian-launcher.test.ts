import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("../../../../scripts/mcp-atlassian.ts", import.meta.url));
const fakeEmail = "mcp-test@example.invalid";
const fakeToken = "offline-atlassian-token-7319";
const fakeBaseUrl = "https://offline.atlassian.net";

type UvxRecord = {
  pid: number;
  descendant?: number;
  argv?: string[];
  env?: Record<string, string>;
  signal?: string;
  descendantReady?: boolean;
};
type Launcher = {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

async function writeFakeUvx(
  directory: string,
  options: {
    log: string;
    stdout?: string;
    stderr?: string;
    ignoreTerm?: boolean;
    descendant?: boolean;
  },
) {
  const script = [
    "#!/usr/bin/env node",
    'import { appendFileSync } from "node:fs";',
    options.ignoreTerm || options.descendant
      ? 'import { spawn as spawnChild } from "node:child_process";'
      : "",
    `const log = (record) => appendFileSync(${JSON.stringify(options.log)}, JSON.stringify({ pid: process.pid, ...record }) + "\\n");`,
    "log({ argv: process.argv.slice(2), env: process.env });",
    options.stdout ? `process.stdout.write(${JSON.stringify(options.stdout)});` : "",
    options.stderr ? `process.stderr.write(${JSON.stringify(options.stderr)});` : "",
    `process.on("SIGTERM", () => { log({ signal: "SIGTERM" }); ${options.ignoreTerm ? "" : "process.exit(0);"} });`,
    `process.on("SIGINT", () => { log({ signal: "SIGINT" }); ${options.ignoreTerm ? "" : "process.exit(0);"} });`,
    options.ignoreTerm || options.descendant
      ? `const descendant = spawnChild(process.execPath, ["-e", ${JSON.stringify(`process.on("SIGTERM", () => {}); require("node:fs").appendFileSync(${JSON.stringify(options.log)}, JSON.stringify({ pid: process.pid, descendantReady: true }) + "\\n"); setInterval(() => {}, 1000);`)}], { stdio: "ignore" }); log({ descendant: descendant.pid });`
      : "",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n");
  await writeFile(join(directory, "uvx"), script);
  await chmod(join(directory, "uvx"), 0o755);
}

async function readUvxLog(path: string): Promise<UvxRecord[]> {
  if (!existsSync(path)) {
    return [];
  }

  const text = await readFile(path, "utf8");

  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as UvxRecord);
}

async function waitFor<T>(read: () => Promise<T | undefined>, message: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read();

    if (value !== undefined) {
      return value;
    }

    await delay(20);
  }

  assert.fail(message);
}

function startLauncher(env: Record<string, string | undefined>, cwd: string): Launcher {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), launcher], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    err += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  return { child, stdout: () => out, stderr: () => err, exited };
}

function launcherEnv(directory: string): Record<string, string | undefined> {
  return {
    PATH: `${directory}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME,
    JIRA_BASE_URL: fakeBaseUrl,
    JIRA_EMAIL: fakeEmail,
    JIRA_API_TOKEN: fakeToken,
    MODEL_API_KEY: "unrelated-model-secret",
    HTTP_PROXY: "http://proxy.invalid:9999",
    HTTPS_PROXY: "http://proxy.invalid:9999",
    ALL_PROXY: "http://proxy.invalid:9999",
    ATLASSIAN_OAUTH_STORE: "/obsolete/store.json",
    READ_ONLY_MODE: "false",
    ENABLED_TOOLS: "jira_delete_issue",
    TOOLSETS: "all",
    PYTHON_DOTENV_DISABLED: "0",
    ALLOW_GLOBAL_CRED_FALLBACK: "false",
    UV_PYTHON: "/custom/python3.13",
    CONFLUENCE_BASE_URL: "https://unapproved.invalid/wiki",
    JIRA_URL: "https://unapproved.invalid",
  };
}

async function stopLauncher(launcher: Launcher, log: string) {
  if (launcher.child.exitCode === null && launcher.child.signalCode === null) {
    launcher.child.kill("SIGKILL");
    await launcher.exited;
  }

  if (process.platform === "win32") {
    return;
  }

  for (const record of await readUvxLog(log)) {
    try {
      process.kill(-record.pid, "SIGKILL");
    } catch {
      continue;
    }
  }
}

test("launcher runs the fixed readonly HTTP command with a sanitized mapped environment and fixed logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chum-launcher-"));
  const log = join(directory, "uvx.jsonl");
  await writeFakeUvx(directory, {
    log,
    stdout: "RAW-SERVER-OUTPUT unsafe",
    stderr: "RAW-SERVER-ERROR unsafe",
  });
  const launcher = startLauncher(launcherEnv(directory), directory);

  try {
    const record = await waitFor(async () => (await readUvxLog(log))[0], "uvx never started");
    assert.deepEqual(record.argv, [
      "--from",
      "mcp-atlassian==0.23.1",
      "mcp-atlassian",
      "--transport",
      "streamable-http",
      "--host",
      "127.0.0.1",
      "--port",
      "8000",
      "--path",
      "/mcp",
      "--read-only",
      "--enabled-tools",
      "jira_get_issue,jira_search,confluence_get_page,confluence_search,confluence_get_comments",
    ]);
    assert.equal(record.env!.JIRA_URL, fakeBaseUrl);
    assert.equal(record.env!.JIRA_USERNAME, fakeEmail);
    assert.equal(record.env!.JIRA_API_TOKEN, fakeToken);
    assert.equal(record.env!.CONFLUENCE_URL, `${fakeBaseUrl}/wiki`);
    assert.equal(record.env!.CONFLUENCE_USERNAME, fakeEmail);
    assert.equal(record.env!.CONFLUENCE_API_TOKEN, fakeToken);
    assert.equal(record.env!.READ_ONLY_MODE, "true");
    assert.equal(record.env!.PYTHON_DOTENV_DISABLED, "1");
    assert.equal(record.env!.ALLOW_GLOBAL_CRED_FALLBACK, "true");
    assert.equal(record.env!.TOOLSETS, "jira_issues,confluence_pages,confluence_comments");
    assert.equal(
      record.env!.ENABLED_TOOLS,
      "jira_get_issue,jira_search,confluence_get_page,confluence_search,confluence_get_comments",
    );
    assert.equal(record.env!.UV_PYTHON, "/custom/python3.13");
    assert.equal(record.env!.PATH, launcherEnv(directory).PATH);

    for (const key of [
      "MODEL_API_KEY",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "ATLASSIAN_OAUTH_STORE",
      "CONFLUENCE_BASE_URL",
    ]) {
      assert.equal(record.env![key], undefined);
    }

    for (const secret of [
      fakeToken,
      `${fakeEmail}:${fakeToken}`,
      Buffer.from(fakeToken).toString("base64"),
      encodeURIComponent(fakeToken),
    ]) {
      assert.equal(JSON.stringify(record.argv).includes(secret), false);
    }

    launcher.child.kill("SIGTERM");
    const exit = await launcher.exited;
    assert.equal(exit.code, 0);
    assert.deepEqual(
      (await readUvxLog(log)).filter((entry) => entry.signal).map((entry) => entry.signal),
      ["SIGTERM"],
    );
    assert.match(
      launcher.stdout(),
      /Starting Atlassian MCP service at http:\/\/127\.0\.0\.1:8000\/mcp/,
    );
    assert.match(launcher.stdout(), /Stopping Atlassian MCP service \(SIGTERM\)/);
    assert.match(launcher.stdout(), /Atlassian MCP service exited with code 0/);
    assert.equal(launcher.stdout().includes("RAW-SERVER-OUTPUT"), false);
    assert.equal(launcher.stderr().includes("RAW-SERVER-ERROR"), false);
    assert.equal(launcher.stdout().includes(fakeToken), false);
    assert.equal(launcher.stderr().includes(fakeToken), false);
  } finally {
    await stopLauncher(launcher, log);
    await rm(directory, { recursive: true, force: true });
  }
});

test("launcher refuses to start without credentials and never invokes uvx", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chum-launcher-"));
  const log = join(directory, "uvx.jsonl");
  await writeFakeUvx(directory, { log });
  const launcher = startLauncher(
    { PATH: `${directory}:${process.env.PATH ?? ""}`, HOME: process.env.HOME },
    directory,
  );

  try {
    const exit = await launcher.exited;
    assert.equal(exit.code, 1);
    assert.match(launcher.stderr(), /Configure JIRA_BASE_URL/);
    assert.deepEqual(await readUvxLog(log), []);
  } finally {
    await stopLauncher(launcher, log);
    await rm(directory, { recursive: true, force: true });
  }
});

test("launcher reports a missing uvx without leaking credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chum-launcher-"));
  const log = join(directory, "uvx.jsonl");
  const environment = launcherEnv(directory);
  environment.PATH = directory;
  const launcher = startLauncher(environment, directory);

  try {
    const exit = await launcher.exited;
    assert.equal(exit.code, 1);
    assert.match(launcher.stderr(), /Failed to start Atlassian MCP service/);
    assert.equal(launcher.stderr().includes(fakeToken), false);
    assert.deepEqual(await readUvxLog(log), []);
  } finally {
    await stopLauncher(launcher, log);
    await rm(directory, { recursive: true, force: true });
  }
});

test("launcher escalates to SIGKILL after five seconds when the service ignores termination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chum-launcher-"));
  const log = join(directory, "uvx.jsonl");
  await writeFakeUvx(directory, { log, ignoreTerm: true });
  const launcher = startLauncher(launcherEnv(directory), directory);

  try {
    const record = await waitFor(
      async () => (await readUvxLog(log)).find((entry) => entry.descendant),
      "uvx descendant never started",
    );
    launcher.child.kill("SIGTERM");
    const exit = await launcher.exited;
    assert.equal(exit.code, 1);
    assert.deepEqual(
      (await readUvxLog(log)).filter((entry) => entry.signal).map((entry) => entry.signal),
      ["SIGTERM"],
    );
    assert.throws(() => process.kill(record.pid, 0), { code: "ESRCH" });
    await waitFor(async () => {
      try {
        process.kill(record.descendant!, 0);

        return undefined;
      } catch {
        return true;
      }
    }, "descendant survived the process group SIGKILL");
  } finally {
    await stopLauncher(launcher, log);
    await rm(directory, { recursive: true, force: true });
  }
});

test("launcher cleans up a service descendant when the uvx parent exits first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chum-launcher-"));
  const log = join(directory, "uvx.jsonl");
  await writeFakeUvx(directory, { log, descendant: true });
  const launcher = startLauncher(launcherEnv(directory), directory);

  try {
    const descendant = await waitFor(
      async () => (await readUvxLog(log)).find((entry) => entry.descendantReady),
      "service descendant never became ready",
    );
    launcher.child.kill("SIGTERM");
    assert.equal((await launcher.exited).code, 0);
    await waitFor(async () => {
      try {
        process.kill(descendant.pid, 0);

        return undefined;
      } catch {
        return true;
      }
    }, "service descendant survived its parent exiting");
    assert.match(launcher.stdout(), /Atlassian MCP service exited with code 0/);
  } finally {
    await stopLauncher(launcher, log);
    await rm(directory, { recursive: true, force: true });
  }
});
