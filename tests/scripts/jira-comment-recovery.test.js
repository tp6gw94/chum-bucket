import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import pg from "pg";
import test from "node:test";

const databaseUrl = process.env.JIRA_COMMENT_RECOVERY_DATABASE_URL;

test(
  "Jira comment workflow recovers pending, ambiguous and cancelled approvals after SIGKILL",
  {
    skip:
      !databaseUrl && "Set JIRA_COMMENT_RECOVERY_DATABASE_URL to an isolated, migrated database",
    timeout: 180_000,
  },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await DBOSClient.create({
      systemDatabaseUrl: databaseUrl,
      systemDatabasePool: pool,
      applicationName: "chum-bucket-chat",
    });
    const workers = [];
    function worker(thread, ambiguous = false) {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--import",
          "./tests/fixtures/delegation-runtime-preload.mjs",
          "./tests/fixtures/delegation-recovery-worker.mjs",
        ],
        {
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl,
            DELEGATION_FIXTURE_SCENARIO: "jira-comment",
            DELEGATION_RECOVERY_THREAD: thread ?? "",
            DELEGATION_FIXTURE_COMMENT_ACCEPT_DELAY: ambiguous ? "30000" : "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const state = { child, output: "" };
      child.stdout.on("data", (chunk) => {
        state.output += chunk;
        process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        state.output += chunk;
        process.stderr.write(chunk);
      });
      workers.push(state);
      return state;
    }
    async function until(read) {
      for (let attempt = 0; attempt < 400; attempt++) {
        const result = await read();
        if (result) return result;
        await delay(100);
      }
      throw new Error("Recovery assertion timed out");
    }
    async function kill(state) {
      if (state.child.exitCode !== null || state.child.signalCode !== null) return;
      const exited = new Promise((resolve) => state.child.once("exit", resolve));
      state.child.kill("SIGKILL");
      await exited;
    }
    async function approvalEvents(threadId, name) {
      const result = await pool.query(
        `select ce.payload from chat_events ce join chat_runs cr on cr.id = ce.run_id
         where cr.thread_id = $1 and ce.payload->>'name' = $2
         order by cr.created_at, ce.sequence`,
        [threadId, name],
      );

      return result.rows.map((row) => row.payload?.value).filter(Boolean);
    }
    async function decision(threadId, approvalId) {
      const requests = await approvalEvents(threadId, "tool.approval.requested");
      const request = requests.find((value) => value.approvalId === approvalId);

      if (!request) throw new Error("Approval request was not persisted");

      const message = (approved) => ({
        approvalId: request.approvalId,
        tool: request.tool,
        digest: request.digest,
        approved,
      });
      const key = `approval-decision:${request.approvalId}`;
      await client.send(request.childWorkflowId, message(true), request.topic, key);
      await client.send(request.childWorkflowId, message(false), request.topic, key);
    }
    try {
      for (const scenario of ["pending", "ambiguous", "cancel"]) {
        const ambiguous = scenario === "ambiguous";
        const first = worker(undefined, ambiguous);
        const thread = await until(() => first.output.match(/RECOVERY_THREAD ([^\s]+)/)?.[1]);
        const request = await until(
          async () => (await approvalEvents(thread, "tool.approval.requested"))[0],
        );
        assert.equal(
          (await approvalEvents(thread, "tool.approval.resolved")).some(
            (value) => value.approvalId === request.approvalId,
          ),
          false,
        );
        assert.equal(first.output.includes('"boundary":"comment-accepted"'), false);
        if (scenario === "pending") await kill(first);
        if (scenario === "cancel") {
          await kill(first);
          await client.send(
            request.childWorkflowId,
            { cancel: true, approvalId: request.approvalId },
            request.topic,
            `approval-cancel:${request.approvalId}`,
          );
        } else {
          await decision(thread, request.approvalId);
        }
        if (ambiguous) {
          await until(() => first.output.includes('"boundary":"comment-accepted"'));
          await kill(first);
        }
        const resumed = worker(thread);
        await until(() => resumed.child.exitCode !== null);
        assert.equal(resumed.child.exitCode, 0, resumed.output);
        const resolution = await until(async () =>
          (await approvalEvents(thread, "tool.approval.resolved"))
            .filter(
              (value) => value.approvalId === request.approvalId && value.state !== "approved",
            )
            .at(-1),
        );
        const resolutions = (await approvalEvents(thread, "tool.approval.resolved")).filter(
          (value) => value.approvalId === request.approvalId,
        );
        assert.equal(resolution.state, scenario === "cancel" ? "cancelled" : "succeeded");
        assert.equal(
          resolutions.some((value) => value.state === "rejected" || value.state === "expired"),
          false,
        );
        const sends = (first.output + resumed.output)
          .split("\n")
          .filter(
            (line) => line.includes('"boundary":"mcp"') && line.includes('"method":"tools/call"'),
          );

        if (scenario === "cancel") {
          assert.equal(sends.length, 0);
        } else {
          assert.ok(sends.length >= 1, "approved comment must be attempted at least once");
        }
        t.diagnostic(`${scenario} recovery verified`);
      }
    } finally {
      await Promise.all(workers.map(kill));
      await client.destroy();
      await pool.end();
    }
  },
);
