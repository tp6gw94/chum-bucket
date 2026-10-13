import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test, mock } from "node:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { Pool } from "pg";
import { executeRun } from "../../../server/harness/run";
import { persistRun } from "../../../server/harness/run-store";

type Row = Record<string, unknown>;

test("the durable loop runs codemode and persists its events before the result", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chum-code-mode-run-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "durable.txt");
  await writeFile(path, "durable-payload");
  const relativePath = relative(process.cwd(), path);
  process.env.DATABASE_URL = "postgresql://offline:offline@127.0.0.1:1/offline";
  process.env.MODEL_API_KEY = "offline";
  const threads = new Map<string, Row>();
  const runs = new Map<string, Row>();
  const events: Row[] = [];
  const threadColumns =
    "id, title, agent, revision, active_run_id, messages, parent_thread_id, created_at, updated_at";
  const runColumns =
    "id, thread_id, request, accepted, projection, state, next_sequence, log_bytes, created_at";
  type SqlHandler = {
    matches: (text: string) => boolean;
    execute: (text: string, values: readonly unknown[]) => Row[];
  };
  const sqlHandlers: ReadonlyArray<SqlHandler> = [
    {
      matches: (text) => ["begin", "commit", "rollback"].includes(text),
      execute: () => [],
    },
    {
      matches: (text) => text.includes(" from side_chats"),
      execute: () => [],
    },
    {
      matches: (text) => text.startsWith(`select ${threadColumns} from threads`),
      execute: (_text, values) =>
        [threads.get(String(values[0]))].filter((row): row is Row => !!row),
    },
    {
      matches: (text) => text.startsWith(`select ${runColumns} from chat_runs where (thread_id`),
      execute: (_text, values) =>
        [...runs.values()].filter(
          (row) =>
            row.thread_id === values[0] &&
            row.state === values[1] &&
            String((row.request as { baseRevision: number }).baseRevision) === values[2],
        ),
    },
    {
      matches: (text) =>
        text.startsWith("select thread_id from chat_runs") ||
        text.startsWith(`select ${runColumns} from chat_runs where id`) ||
        text.startsWith(`select ${runColumns} from chat_runs where state`),
      execute: (text, values) =>
        [...runs.values()].filter((row) =>
          text.includes("where id") ? row.id === values[0] : true,
        ),
    },
    {
      matches: (text) => text.startsWith("insert into chat_runs"),
      execute: (_text, values) => {
        const [a, b, c, d, e] = values;
        const row = {
          id: a,
          thread_id: b,
          request: JSON.parse(String(c)),
          accepted: JSON.parse(String(d)),
          projection: JSON.parse(String(e)),
          state: "pending",
          next_sequence: 0,
          log_bytes: 0,
        };
        runs.set(String(a), row);

        return [row];
      },
    },
    {
      matches: (text) => text.startsWith("update chat_runs set projection"),
      execute: (_text, values) => {
        runs.get(String(values[1]))!.projection = JSON.parse(String(values[0]));

        return [];
      },
    },
    {
      matches: (text) => text.startsWith("update threads set title"),
      execute: (_text, values) => {
        const thread = threads.get(String(values[3]))!;
        thread.title = values[0];
        thread.messages = JSON.parse(String(values[2]));
        thread.revision = Number(thread.revision) + 1;
        thread.active_run_id = null;

        return [];
      },
    },
    {
      matches: (text) => text.startsWith("update threads set active_run_id"),
      execute: (_text, values) => {
        threads.get(String(values[1]))!.active_run_id = values[0];

        return [];
      },
    },
    {
      matches: (text) => text.startsWith("select sequence, payload from chat_events"),
      execute: (_text, values) => {
        const [a, b, c] = values;

        return events
          .filter((row) => row.run_id === a && Number(row.sequence) > Number(b))
          .sort((left, right) => Number(left.sequence) - Number(right.sequence))
          .slice(0, Number(c));
      },
    },
    {
      matches: (text) => text.startsWith("insert into chat_events"),
      execute: (_text, values) => {
        const [a, b, c, d] = values;
        events.push({ run_id: a, sequence: b, event_key: c, payload: JSON.parse(String(d)) });

        return [];
      },
    },
    {
      matches: (text) => text.startsWith("update chat_runs set next_sequence"),
      execute: (_text, values) => {
        const run = runs.get(String(values[1]))!;
        run.next_sequence = Number(run.next_sequence) + 1;
        run.log_bytes = Number(run.log_bytes) + Number(values[0]);

        return [];
      },
    },
    {
      matches: (text) => text.startsWith("update chat_runs set state"),
      execute: (_text, values) => {
        runs.get(String(values[1]))!.state = values[0];

        return [];
      },
    },
    {
      matches: (text) => text.includes("testing_") && !text.includes("from chat_runs"),
      execute: () => [],
    },
  ];

  const projectQueryRows = (config: string | { text: string }, text: string, rows: Row[]) => {
    const columns = text.startsWith("select ")
      ? text.slice(7, text.indexOf(" from "))
      : text.split(" returning ")[1];

    return {
      rows: structuredClone(
        typeof config !== "string" && "rowMode" in config && config.rowMode === "array" && columns
          ? rows.map((row) => columns.split(", ").map((column) => row[column]))
          : rows,
      ),
      rowCount: rows.length,
    };
  };

  const query = async (config: string | { text: string }, values: unknown[] = []) => {
    const text = (typeof config === "string" ? config : config.text)
      .replace(/"(?:threads|chat_runs|chat_events)"\./g, "")
      .replaceAll('"', "");
    const handler = sqlHandlers.find((entry) => entry.matches(text));

    if (!handler) {
      throw new Error(`Unsupported offline SQL: ${text}`);
    }

    return projectQueryRows(config, text, handler.execute(text, values));
  };

  const pool = Pool.prototype as unknown as {
    connect: () => Promise<{ query: typeof query; release: () => void }>;
  };
  const connected = mock.method(pool, "connect", async () => ({ query, release: () => {} }));
  const stepped = mock.method(DBOS, "runStep", async (callback: () => Promise<unknown>) =>
    callback(),
  );
  const threadId = "11111111-2222-4333-8444-555555555555";
  threads.set(threadId, { id: threadId, messages: [], revision: 0, active_run_id: null });
  const accepted = await persistRun({
    threadId,
    runId: "code-mode-run",
    baseRevision: 0,
    message: { id: "user-1", text: "read the file" },
  });
  const { deepinfra } = await import("../../../server/harness/provider");
  const adapter = deepinfra(accepted.run.model);
  const code = `
    const file = await external_read({ path: ${JSON.stringify(relativePath)} });
    return file.content.map((part) => part.text).join("");
  `;
  let modelCalls = 0;
  const provider = mock.method(
    Object.getPrototypeOf(adapter),
    "chatStream",
    async function* (options: {
      systemPrompts?: string[];
      tools?: { name: string; inputSchema?: { required?: unknown; properties?: unknown } }[];
      messages: { role: string; content: unknown }[];
    }) {
      assert.equal(options.systemPrompts?.[0], accepted.run.prompt);
      assert.match(options.systemPrompts?.[1] ?? "", /external_read/);
      const codeMode = options.tools?.find((tool) => tool.name === "codemode");
      assert.ok(codeMode);
      assert.deepEqual(codeMode.inputSchema?.required, ["code"]);
      const properties = codeMode.inputSchema?.properties as
        | Record<string, { type?: unknown }>
        | undefined;
      assert.equal(properties?.code?.type, "string");
      assert.equal(properties !== undefined && "typescriptCode" in properties, false);
      modelCalls++;

      if (modelCalls === 1) {
        const id = "code-mode-source";
        yield {
          type: EventType.TOOL_CALL_START,
          toolCallId: id,
          toolCallName: "codemode",
        };
        yield {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: id,
          delta: JSON.stringify({ code }),
        };
        yield {
          type: EventType.TOOL_CALL_END,
          toolCallId: id,
          input: { code },
        };
        yield { type: EventType.RUN_FINISHED, threadId: "provider", runId: "provider" };

        return;
      }

      const toolMessages = options.messages.filter((message) => message.role === "tool");
      assert.equal(toolMessages.length, 1);
      assert.match(String(toolMessages[0]!.content), /durable-payload/);
      yield { type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" };
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer", delta: "read" };
      yield { type: EventType.TEXT_MESSAGE_END, messageId: "answer" };
      yield { type: EventType.RUN_FINISHED, threadId: "provider", runId: "provider" };
    },
  );

  try {
    await executeRun(accepted.run);
  } finally {
    provider.mock.restore();
    stepped.mock.restore();
    connected.mock.restore();
  }

  assert.equal(modelCalls, 2);
  assert.equal(runs.get("code-mode-run")!.state, "succeeded");
  const persisted = events.map((row) => row.payload as StreamChunk);
  const custom = persisted.filter((event) => event.type === EventType.CUSTOM);
  assert.deepEqual(
    custom.map((event) => (event as { name: string }).name),
    [
      "code_mode:execution_started",
      "code_mode:external_call",
      "code_mode:external_result",
      "code_mode:execution_finished",
    ],
  );
  const resultIndex = persisted.findIndex((event) => event.type === EventType.TOOL_CALL_RESULT);
  const finishedIndex = persisted.findIndex(
    (event) =>
      event.type === EventType.CUSTOM &&
      (event as { name: string }).name === "code_mode:execution_finished",
  );
  assert.ok(resultIndex > finishedIndex, "the tool result persists after its custom events");
  const result = JSON.parse((persisted[resultIndex] as unknown as { content: string }).content) as {
    success: boolean;
    result: unknown;
  };
  assert.equal(result.success, true);
  assert.equal(result.result, "durable-payload");
  const saved = threads.get(threadId)!.messages as unknown[];
  assert.ok(JSON.stringify(saved).includes("durable-payload"));
  await readFile(path, "utf8");
});
