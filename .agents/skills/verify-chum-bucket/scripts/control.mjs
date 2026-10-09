import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "../../../..");
const [command, argument] = process.argv.slice(2);
assert(argument, "Usage: node control.mjs launch|doctor|inspect|cleanup EVIDENCE_DIR");
const directory = resolve(argument);
const statePath = resolve(directory, "instance.json");
const exec = (binary, args) =>
  execFileSync(binary, args, { cwd: root, encoding: "utf8", timeout: 30_000 }).trim();
const readState = async () => JSON.parse(await readFile(statePath, "utf8"));
const save = async (state) => writeFile(statePath, JSON.stringify(state, null, 2));

async function fingerprint() {
  const files = exec("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "src",
    "server",
    "shared",
    "components",
    "lib",
    "package.json",
    "pnpm-lock.yaml",
    "vite.config.js",
    "index.html",
  ]);
  const hash = createHash("sha256");
  for (const file of [...new Set(files.split("\n"))].sort()) {
    hash.update(file);
    hash.update(await readFile(resolve(root, file)));
  }
  return hash.digest("hex");
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function until(check, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for verification instance; inspect launch.log");
}

async function supervisorRequest(state, stop = false) {
  const response = await fetch(
    `http://127.0.0.1:${state.controlPort}/${stop ? "cleanup" : "status"}`,
    {
      method: stop ? "POST" : "GET",
      headers: { authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(5000),
    },
  );
  assert.equal(response.status, 200);
  const identity = await response.json();
  assert.equal(identity.token, state.token);
  assert.equal(identity.pid, state.pid);
  assert.equal(identity.root, root);
}

function container(state) {
  const info = JSON.parse(exec("docker", ["inspect", state.container]))[0];
  assert.equal(info.Config.Labels["chum-bucket-verification"], state.token);
  return info;
}

function sql(state, query) {
  container(state);
  return exec("docker", [
    "exec",
    state.container,
    "psql",
    "-U",
    "postgres",
    "-d",
    "verify",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    query,
  ]);
}

async function doctor() {
  const state = await readState();
  assert.equal(state.status, "ready");
  assert.equal(state.root, root);
  await supervisorRequest(state);
  assert.equal(state.fingerprint, await fingerprint(), "Source changed; launch a fresh instance");
  const info = container(state);
  assert(info.State.Running);
  for (const [port, pid] of [
    [state.clientPort, state.pid],
    [state.serverPort, state.serverPid],
  ]) {
    const owners = exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).split("\n");
    assert.deepEqual([...new Set(owners)], [String(pid)], "Port is not owned by this run");
  }
  const response = await fetch(`${state.origin}/api/thread`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  assert(Array.isArray(await response.json()));
  assert(
    (await (await fetch(state.origin, { signal: AbortSignal.timeout(10_000) })).text()).includes(
      "/src/main.tsx",
    ),
  );
  assert.equal(sql(state, "SELECT current_database()"), "verify");
  console.log(
    JSON.stringify(
      {
        status: "pass",
        origin: state.origin,
        serverPid: state.serverPid,
        supervisorPid: state.pid,
        container: state.container,
        fingerprint: state.fingerprint,
        external: state.external,
      },
      null,
      2,
    ),
  );
}

async function supervise() {
  const token = randomUUID();
  const state = {
    root,
    pid: process.pid,
    token,
    container: `chum-verify-${token}`,
    status: "starting",
    external: process.env.VERIFY_EXTERNAL === "1",
  };
  let backend;
  let vite;
  let stopping;
  let interrupted = false;
  const controller = createHttpServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403).end();
      return;
    }
    if (request.method === "POST" && request.url === "/cleanup") {
      interrupted = true;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ token, pid: process.pid, root }));
  });
  await new Promise((done) => controller.listen(0, "127.0.0.1", done));
  state.controlPort = controller.address().port;
  async function cleanup(error) {
    if (stopping) {
      return stopping;
    }
    stopping = (async () => {
      if (vite) {
        await Promise.race([vite.close(), delay(10_000)]);
      }
      if (backend && backend.exitCode === null && backend.signalCode === null) {
        backend.kill("SIGTERM");
        await until(
          async () => backend.exitCode !== null || backend.signalCode !== null,
          15_000,
        ).catch(() => backend.kill("SIGKILL"));
        await until(async () => backend.exitCode !== null || backend.signalCode !== null, 5000);
      }
      try {
        exec("docker", ["logs", state.container]);
      } catch {}
      try {
        container(state);
        exec("docker", ["rm", "-f", "-v", state.container]);
      } catch (failure) {
        if (!String(failure).toLowerCase().includes("no such object")) {
          throw failure;
        }
      }
      await new Promise((done) => controller.close(done));
      await rm(resolve(directory, "vite-cache"), { recursive: true, force: true });
      state.status = error ? "failed" : "cleaned";
      state.error = error?.message;
      state.cleanedAt = new Date().toISOString();
      await save(state);
      console.log(JSON.stringify({ cleanup: state.status, evidence: directory }));
    })();
    return stopping;
  }
  const stop = () => {
    interrupted = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await save(state);
  try {
    state.fingerprint = await fingerprint();
    state.containerId = exec("docker", [
      "run",
      "--pull=never",
      "-d",
      "--name",
      state.container,
      "--label",
      `chum-bucket-verification=${token}`,
      "--tmpfs",
      "/var/lib/postgresql/data",
      "-p",
      "127.0.0.1::5432",
      "-e",
      "POSTGRES_PASSWORD=verification",
      "-e",
      "POSTGRES_DB=verify",
      "postgres:17-alpine",
    ]);
    await until(async () => {
      assert(!interrupted, "Launch interrupted");
      try {
        return exec("docker", [
          "exec",
          state.container,
          "pg_isready",
          "-U",
          "postgres",
          "-d",
          "verify",
        ]).includes("accepting connections");
      } catch {
        return false;
      }
    });
    const databasePort = container(state).NetworkSettings.Ports["5432/tcp"][0].HostPort;
    const env = {
      ...process.env,
      DATABASE_URL: `postgresql://postgres:verification@127.0.0.1:${databasePort}/verify`,
    };
    if (!state.external) {
      for (const key of [
        "MODEL_API_KEY",
        "JIRA_BASE_URL",
        "JIRA_EMAIL",
        "JIRA_API_TOKEN",
        "ATLASSIAN_MCP_URL",
        "FIGMA_API_KEY",
      ]) {
        env[key] = "";
      }
    }
    execFileSync("pnpm", ["exec", "drizzle-kit", "push", "--force"], {
      cwd: root,
      env,
      stdio: "inherit",
      timeout: 60_000,
    });
    assert(!interrupted, "Launch interrupted");
    state.serverPort = await freePort();
    state.clientPort = await freePort();
    assert.notEqual(state.serverPort, state.clientPort);
    backend = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: root,
      env: { ...env, PORT: String(state.serverPort) },
      stdio: "inherit",
    });
    state.serverPid = backend.pid;
    backend.on("exit", () => {
      interrupted = true;
    });
    const { createServer: createVite } = await import("vite");
    vite = await createVite({
      root,
      configFile: resolve(root, "vite.config.js"),
      cacheDir: resolve(directory, "vite-cache"),
      server: {
        host: "127.0.0.1",
        port: state.clientPort,
        strictPort: true,
        proxy: { "/api": { target: `http://127.0.0.1:${state.serverPort}`, changeOrigin: true } },
      },
    });
    await vite.listen();
    state.origin = `http://127.0.0.1:${state.clientPort}`;
    await until(async () => {
      assert(!interrupted, "Backend stopped before readiness");
      try {
        return (
          (await fetch(`${state.origin}/api/thread`, { signal: AbortSignal.timeout(1000) }))
            .status === 200
        );
      } catch {
        return false;
      }
    });
    state.status = "ready";
    await save(state);
    console.log(`READY ${state.origin}`);
    while (!interrupted) {
      await delay(250);
    }
    await cleanup();
  } catch (error) {
    console.error(error);
    await cleanup(error);
    process.exitCode = 1;
  }
}

if (command === "launch") {
  await mkdir(directory, { recursive: true });
  assert(!(await readState().catch(() => null)), "Use a new evidence directory for each launch");
  const log = openSync(resolve(directory, "launch.log"), "a", 0o600);
  const child = spawn(process.execPath, [script, "supervise", directory], {
    cwd: root,
    env: process.env,
    detached: true,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  child.unref();
  try {
    await until(async () => {
      const state = await readState().catch(() => null);
      assert(state?.status !== "failed", state?.error);
      return state?.status === "ready";
    });
    await doctor();
  } catch (error) {
    const state = await readState().catch(() => null);
    child.kill("SIGTERM");
    if (state) {
      await until(async () => ["cleaned", "failed"].includes((await readState()).status), 60_000);
    }
    throw error;
  }
} else if (command === "supervise") {
  await supervise();
} else if (command === "doctor") {
  await doctor();
} else if (command === "inspect") {
  await doctor();
  const state = await readState();
  const query =
    "SELECT json_build_object('threads', (SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT id,title,messages,revision,active_run_id FROM threads ORDER BY created_at) t), 'runs', (SELECT coalesce(json_agg(r), '[]'::json) FROM (SELECT id,thread_id,state FROM chat_runs ORDER BY created_at) r), 'eventCount', (SELECT count(*) FROM chat_events))";
  const proof = sql(state, query);
  await writeFile(resolve(directory, "database.json"), proof + "\n");
  console.log(proof);
} else if (command === "cleanup") {
  const state = await readState();
  if (!["cleaned", "failed"].includes(state.status)) {
    await supervisorRequest(state, true);
    await until(async () => ["cleaned", "failed"].includes((await readState()).status), 60_000);
  }
  const final = await readState();
  assert(final.cleanedAt);
  for (const port of [final.clientPort, final.serverPort, final.controlPort].filter(Boolean)) {
    let listening = false;
    try {
      exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
      listening = true;
    } catch {}
    assert(!listening, `Port ${port} is still in use`);
  }
  let exists = false;
  try {
    container(final);
    exists = true;
  } catch (error) {
    assert(String(error).toLowerCase().includes("no such object"), "Container identity mismatch");
  }
  assert(!exists, "Verification container still exists");
  console.log(JSON.stringify({ status: "cleaned", evidence: directory }));
} else {
  throw new Error(`Unknown command: ${command}`);
}
