import { spawn } from "node:child_process";
import { config as loadEnv } from "dotenv";
import {
  atlassianToolNames,
  readAtlassianConfiguration,
  type Environment,
} from "../server/harness/tools/atlassian-policy";

const SERVICE_URL = "http://127.0.0.1:8000/mcp";
const SIGKILL_DELAY_MS = 5_000;
const CHILD_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMPDIR",
  "TMP",
  "SystemRoot",
  "windir",
  "COMSPEC",
  "PATHEXT",
];

loadEnv({ quiet: true });

function childEnvironment(
  env: Environment,
  serviceEnvironment: Readonly<Record<string, string>>,
): Record<string, string> {
  const child: Record<string, string> = {};

  for (const key of CHILD_KEYS) {
    const value = env[key];

    if (value !== undefined) {
      child[key] = value;
    }
  }

  if (env.UV_PYTHON) {
    child.UV_PYTHON = env.UV_PYTHON;
  }

  return { ...child, ...serviceEnvironment };
}

function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    return;
  }
}

function launch(env: Environment) {
  let configuration;

  try {
    configuration = readAtlassianConfiguration(env);
  } catch (failure) {
    console.error(
      failure instanceof Error ? failure.message : "Atlassian configuration is invalid",
    );
    process.exitCode = 1;

    return;
  }

  if (configuration.mode === "local") {
    console.error(
      "Configure JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN to start the Atlassian MCP service",
    );
    process.exitCode = 1;

    return;
  }

  const child = spawn(
    "uvx",
    [
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
      "--enabled-tools",
      atlassianToolNames.join(","),
    ],
    {
      env: childEnvironment(env, configuration.serviceEnvironment),
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  let terminating = false;
  let killer: NodeJS.Timeout | undefined;

  const forward = (signal: NodeJS.Signals) => {
    if (terminating) {
      return;
    }

    terminating = true;
    console.log(`Stopping Atlassian MCP service (${signal}).`);
    killGroup(child.pid!, signal);
    killer = setTimeout(() => {
      killGroup(child.pid!, "SIGKILL");
    }, SIGKILL_DELAY_MS);
    killer.unref();
  };

  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  child.on("error", () => {
    console.error("Failed to start Atlassian MCP service. Install uv and add uvx to PATH.");
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (child.pid && process.platform !== "win32") {
      killGroup(child.pid, "SIGKILL");
    }

    if (killer) {
      clearTimeout(killer);
    }

    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    console.log(
      signal
        ? `Atlassian MCP service stopped (${signal}).`
        : `Atlassian MCP service exited with code ${code ?? 1}.`,
    );
    process.exitCode = code ?? 1;
  });
  console.log(`Starting Atlassian MCP service at ${SERVICE_URL}`);
}

launch(process.env);
