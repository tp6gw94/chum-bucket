import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { eq } from "drizzle-orm";
import { StreamProcessor, type UIMessage } from "@tanstack/ai";
import { fetchServerSentEvents } from "@tanstack/ai-react";
import {
  threadsTable,
  sideChatsTable,
  chatRunsTable,
  sideTransfersTable,
} from "../../../server/db/schema";
import {
  acceptRun,
  discardSideChat,
  ensureStarted,
  launchChatRuntime,
  shutdownChatRuntime,
} from "../../../server/harness/run";
import {
  heartbeatSideScope,
  database,
  persistRun,
  finishRun,
  emit,
  checkpointCompaction,
  hydrateThread,
  openSideChat,
  readSideSummaryRange,
  saveSideDraft,
  transferSideSummary,
} from "../../../server/harness/run-store";
import {
  SIDE_SCOPE_HEADER,
  summaryTransferFailure,
  transferReceiptSchema,
  type SummaryTransfer,
} from "../../../shared/side-chat";
import { sideRequest } from "../../../src/hooks/use-side-chats";
import chat from "../../../server/chat";
import sideChat from "../../../server/side-chat";
import { snapshot } from "../../../server/harness/model-turn";

const enabled = process.env.SIDE_CHAT_TEST_DATABASE_URL;
const message = (id: string, content: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", content }],
});

async function waitFor(predicate: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) {
      return;
    }

    await delay(20);
  }

  throw new Error("Outcome did not settle");
}

test(
  "side chat lifecycle and atomic handoff against PostgreSQL and the real DBOS SDK",
  { skip: !enabled, timeout: 60_000 },
  async (t) => {
    assert.equal(process.env.DATABASE_URL, enabled);
    const db = await database();
    const scope = { scope: randomUUID() };
    let slow = false;
    let aborted = false;
    let modelCalls = 0;
    let toolMode = false;
    let toolDispatched = false;
    let toolAborted = false;
    const requested: string[] = [];
    const provider = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      if (String(_url).includes("api.figma.com")) {
        toolDispatched = true;

        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              toolAborted = true;
              reject(new Error("Cancelled Figma"));
            },
            { once: true },
          );
        });
      }

      modelCalls++;
      requested.push(String(init?.body));
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = (value: unknown) =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
          const delta = toolMode
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `figma-${modelCalls}`,
                    type: "function",
                    function: {
                      name: "get_figma",
                      arguments: JSON.stringify({ target: "testfile" }),
                    },
                  },
                ],
              }
            : { role: "assistant", content: "附屬結論" };
          chunk({
            id: `provider-${modelCalls}`,
            choices: [{ index: 0, delta, finish_reason: null }],
          });

          if (slow) {
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                controller.error(new Error("Cancelled provider"));
              },
              { once: true },
            );
          } else {
            chunk({
              id: `provider-${modelCalls}`,
              choices: [{ index: 0, delta: {}, finish_reason: toolMode ? "tool_calls" : "stop" }],
            });
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        },
      });

      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    });
    await launchChatRuntime();

    try {
      const parentId = randomUUID();
      await db.insert(threadsTable).values({ id: parentId, title: "Parent", messages: [] });
      const base = await persistRun({
        threadId: parentId,
        runId: `base-${randomUUID()}`,
        baseRevision: 0,
        message: { id: "parent-user", text: "PARENT SECRET" },
      });
      const compactSummary: UIMessage = {
        ...message("parent-summary", "PARENT SUMMARY"),
        metadata: { fromSummary: true },
      };
      const parentState = {
        display: [...base.run.messages, compactSummary],
        context: [message("parent-summary", "effective parent context")],
      };
      await finishRun(base.run.runId, parentState);
      const beforeParent = await hydrateThread(parentId);
      const first = await openSideChat(parentId, randomUUID(), scope);
      const second = await openSideChat(parentId, randomUUID(), scope);
      await t.test(
        "compacted seed uses the exact display and model context, with independent children and no nested fork",
        async () => {
          const accepted = await persistRun(
            {
              threadId: first.id,
              runId: `side-${randomUUID()}`,
              baseRevision: 0,
              message: { id: "child-user", text: "CHILD ORIGINAL" },
            },
            scope,
          );
          assert.equal(
            accepted.run.context[0]?.parts[0]?.type === "text" &&
              accepted.run.context[0].parts[0].content,
            "effective parent context",
          );
          assert.deepEqual(accepted.run.messages.slice(0, -1), beforeParent.messages);
          const childSummary: UIMessage = {
            ...message("child-summary", "COMPACTION ADMIN"),
            metadata: { fromSummary: true },
          };
          const childAnswer: UIMessage = {
            id: "child-answer",
            role: "assistant",
            parts: [
              { type: "text", content: "CHILD DECISION" },
              {
                type: "tool-call",
                id: "child-tool",
                name: "read",
                arguments: '{"path":"child-only.txt"}',
                state: "complete",
              },
              {
                type: "tool-result",
                toolCallId: "child-tool",
                content: "RAW CHILD TOOL EVIDENCE",
                state: "complete",
              },
            ],
          };
          await checkpointCompaction(
            accepted.run.runId,
            "child-compact",
            {
              display: [...accepted.run.messages, childAnswer, childSummary],
              context: [childSummary],
            },
            "done",
          );
          const secondSummary: UIMessage = {
            ...message("child-summary-2", "COMPACTION ADMIN SECOND"),
            metadata: { fromSummary: true },
          };
          const twiceCompacted = {
            display: [...accepted.run.messages, childAnswer, childSummary, secondSummary],
            context: [secondSummary],
          };
          await checkpointCompaction(
            accepted.run.runId,
            "child-compact-second",
            twiceCompacted,
            "done",
          );
          await finishRun(accepted.run.runId, twiceCompacted);
          const range = await readSideSummaryRange(first.id, scope);
          assert.deepEqual(
            range.transcript.map((entry) => entry.id),
            ["child-user", "child-answer"],
          );
          assert.equal(range.through, 2);
          assert.deepEqual(range.transcript[1].parts, childAnswer.parts);
          assert.deepEqual(
            range.transcript[1].parts.filter((part) => part.type === "tool-result"),
            [
              {
                type: "tool-result",
                toolCallId: "child-tool",
                content: "RAW CHILD TOOL EVIDENCE",
                state: "complete",
              },
            ],
          );
          assert.deepEqual((await hydrateThread(second.id, scope)).messages, beforeParent.messages);
          assert.deepEqual(await hydrateThread(parentId), beforeParent);
          await assert.rejects(openSideChat(first.id, randomUUID(), scope), /Nested/);
          await assert.rejects(hydrateThread(first.id), /scope/);
          await assert.rejects(
            persistRun({
              threadId: first.id,
              runId: `unauthorized-${randomUUID()}`,
              baseRevision: 1,
              message: { id: "bad", text: "bad" },
            }),
            /scope/,
          );
        },
      );
      await t.test(
        "summary preview submits only raw child provenance and never writes the parent",
        async () => {
          const before = await hydrateThread(parentId);
          const response = await sideChat.request(`/${first.id}/summary`, {
            method: "POST",
            headers: { [SIDE_SCOPE_HEADER]: scope.scope },
          });
          assert.equal(response.status, 200);
          const preview = (await response.json()) as { text: string; through: number };
          assert.equal(preview.text, "附屬結論");
          assert.equal(preview.through, 2);
          const body = requested.at(-1)!;
          assert.match(body, /CHILD ORIGINAL/);
          assert.match(body, /CHILD DECISION/);
          assert.match(body, /RAW CHILD TOOL EVIDENCE/);
          assert.doesNotMatch(body, /PARENT SECRET|PARENT SUMMARY|COMPACTION ADMIN/);
          assert.deepEqual(await hydrateThread(parentId), before);
        },
      );
      const range = await readSideSummaryRange(first.id, scope);
      const draft = await saveSideDraft(first.id, scope, range.epoch, {
        id: randomUUID(),
        sideRevision: range.sideRevision,
        through: range.through,
        text: "Child draft",
      });
      const transfer = {
        draftId: draft.id,
        transferKey: randomUUID(),
        text: "Edited child handoff",
      };
      await t.test(
        "busy parent preserves the draft and does not consume the transfer key",
        async () => {
          const busy = await persistRun({
            threadId: parentId,
            runId: `busy-${randomUUID()}`,
            baseRevision: 1,
            message: { id: "busy-user", text: "Busy parent" },
          });
          await assert.rejects(transferSideSummary(first.id, scope, transfer), /busy/);
          const [side] = await db
            .select()
            .from(sideChatsTable)
            .where(eq(sideChatsTable.id, first.id));
          assert.equal(side.state, "open");
          assert.deepEqual(side.draft, draft);
          const receipts = await db
            .select()
            .from(sideTransfersTable)
            .where(eq(sideTransfersTable.transfer_key, transfer.transferKey));
          assert.equal(receipts.length, 0);
          await finishRun(busy.run.runId, {
            display: busy.run.messages,
            context: busy.run.context,
          });
        },
      );
      await t.test(
        "handoff claims the main run atomically, starts its model, and a lost response does not duplicate after child purge",
        async () => {
          const accepted = await transferSideSummary(first.id, scope, transfer);
          const duplicate = await transferSideSummary(first.id, scope, transfer);
          assert.deepEqual(duplicate.receipt, accepted.receipt);
          assert.equal(accepted.run.messages.at(-1)?.metadata?.fromSummary, undefined);
          assert.equal(accepted.run.messages.at(-1)?.role, "user");
          await ensureStarted(accepted.run);
          await waitFor(async () => (await hydrateThread(parentId)).activeRun === null);
          assert.ok(requested.some((body) => body.includes("Edited child handoff")));
          await waitFor(
            async () =>
              (await db.select().from(sideChatsTable).where(eq(sideChatsTable.id, first.id)))[0]
                ?.state === "closed",
          );
          const replay = await transferSideSummary(first.id, scope, transfer);
          assert.deepEqual(replay.receipt, accepted.receipt);
          await assert.rejects(
            transferSideSummary(first.id, scope, { ...transfer, text: "changed" }),
            /collision/,
          );
          assert.equal(
            (await hydrateThread(parentId)).messages.filter(
              (entry) => entry.id === accepted.receipt.messageId,
            ).length,
            1,
          );
          const [tombstone] = await db
            .select()
            .from(sideChatsTable)
            .where(eq(sideChatsTable.id, first.id));
          assert.equal(tombstone.state, "closed");
          assert.equal(tombstone.seed, null);
          assert.equal(tombstone.draft, null);
          assert.equal(
            (await db.select().from(chatRunsTable).where(eq(chatRunsTable.thread_id, first.id)))
              .length,
            0,
          );
        },
      );
      await t.test(
        "uncertain HTTP outcomes retry the frozen operation and observe one accepted parent run through nativeSSE",
        async () => {
          for (const fault of [
            "lost-response",
            "post-commit-503",
            "invalid-receipt",
            "before-acceptance",
          ] as const) {
            const child = await openSideChat(parentId, randomUUID(), scope);
            const childRun = await persistRun(
              {
                threadId: child.id,
                runId: `fault-child-${randomUUID()}`,
                baseRevision: 0,
                message: { id: randomUUID(), text: "Child evidence for a frozen handoff" },
              },
              scope,
            );
            await finishRun(childRun.run.runId, {
              display: childRun.run.messages,
              context: childRun.run.context,
            });
            const range = await readSideSummaryRange(child.id, scope);
            const draft = await saveSideDraft(child.id, scope, range.epoch, {
              id: randomUUID(),
              sideRevision: range.sideRevision,
              through: range.through,
              text: "Frozen handoff evidence",
            });
            const transferKey = randomUUID();
            let summary: SummaryTransfer = {
              kind: "draft",
              draft,
              text: "Exactly one frozen parent handoff",
              key: transferKey,
            };
            const before = await hydrateThread(parentId);
            const bodies: string[] = [];
            const providerFetch = globalThis.fetch;
            let loseResponse = true;
            const boundary = mock.method(
              globalThis,
              "fetch",
              async (url: unknown, init?: RequestInit) => {
                const path = String(url);

                if (!path.startsWith("/api/side-chat/")) {
                  return providerFetch(url as RequestInfo, init);
                }

                bodies.push(String(init?.body));

                if (loseResponse && fault === "before-acceptance") {
                  loseResponse = false;
                  throw new TypeError("Connection failed before the request arrived");
                }

                const response = await sideChat.request(path.slice("/api/side-chat".length), init);
                assert.equal(response.status, 200);

                if (loseResponse) {
                  loseResponse = false;
                  await response.json();

                  if (fault === "post-commit-503") {
                    return Response.json(
                      { error: "SDK start failed after commit" },
                      { status: 503 },
                    );
                  }

                  if (fault === "invalid-receipt") {
                    return Response.json({ accepted: true });
                  }

                  throw new TypeError("Accepted receipt was lost in transit");
                }

                return response;
              },
            );
            const confirm = () =>
              sideRequest(`/${child.id}/transfer`, scope.scope, {
                method: "POST",
                body: JSON.stringify({
                  draftId: summary.draft.id,
                  transferKey: summary.key,
                  text: summary.text,
                }),
              }).then((body) => transferReceiptSchema.parse(body));

            try {
              try {
                await confirm();
                assert.fail("The injected uncertain outcome must not return a receipt");
              } catch (cause) {
                summary = summaryTransferFailure(summary, cause);
              }

              assert.deepEqual(summary, {
                kind: "unresolved",
                draft,
                text: "Exactly one frozen parent handoff",
                key: transferKey,
              });
              await waitFor(async () => (await hydrateThread(parentId)).activeRun === null);
              const receipt = await confirm();
              await waitFor(async () => (await hydrateThread(parentId)).activeRun === null);
              assert.deepEqual(await confirm(), receipt);
              assert.equal(receipt.transferKey, transferKey);
              const expectedBody = JSON.stringify({
                draftId: draft.id,
                transferKey,
                text: "Exactly one frozen parent handoff",
              });
              assert.deepEqual(bodies, [expectedBody, expectedBody, expectedBody]);
              const main = await hydrateThread(parentId);
              const newMessages = main.messages.slice(before.messages.length);
              assert.deepEqual(
                newMessages.filter((entry) => entry.role === "user").map((entry) => entry.parts),
                [[{ type: "text", content: "Exactly one frozen parent handoff" }]],
              );
              assert.equal(newMessages.filter((entry) => entry.role === "assistant").length, 1);
              assert.equal(
                (
                  await db
                    .select()
                    .from(sideTransfersTable)
                    .where(eq(sideTransfersTable.transfer_key, summary.key))
                ).length,
                1,
              );
              assert.equal(
                (
                  await db
                    .select()
                    .from(chatRunsTable)
                    .where(eq(chatRunsTable.id, receipt.mainRunId))
                ).length,
                1,
              );
              const connection = fetchServerSentEvents("http://offline/api/chat", {
                fetchClient: async (url, init) => chat.request(new URL(String(url)).search, init),
                reconnect: { maxAttempts: 0 },
              });
              const processor = new StreamProcessor({ initialMessages: before.messages });

              for await (const chunk of connection.joinRun!(receipt.mainRunId)) {
                processor.processChunk(chunk);
              }

              const visible = (messages: UIMessage[]) =>
                messages.map(({ id, role, parts }) => ({ id, role, parts }));
              assert.deepEqual(visible(processor.getMessages()), visible(main.messages));
              await waitFor(
                async () =>
                  (await db.select().from(sideChatsTable).where(eq(sideChatsTable.id, child.id)))[0]
                    ?.state === "closed",
              );
              assert.deepEqual(await confirm(), receipt);
            } finally {
              boundary.mock.restore();
            }
          }
        },
      );
      await t.test(
        "live cancellation drains SDK writes before deleting every child checkpoint and fences late writes",
        async () => {
          slow = true;
          const child = await openSideChat(parentId, randomUUID(), scope);
          const callsBefore = modelCalls;
          const run = await acceptRun(
            {
              threadId: child.id,
              runId: `slow-${randomUUID()}`,
              baseRevision: 0,
              message: { id: "slow-user", text: "slow" },
            },
            scope,
          );
          await waitFor(async () => modelCalls > callsBefore);
          const beforeSteps = await DBOS.listWorkflowSteps(run.runId);
          assert.ok(beforeSteps?.some((step) => step.name === "compact:0"));
          await discardSideChat(child.id, scope);
          assert.equal(aborted, true);
          assert.equal(modelCalls, callsBefore + 1);
          assert.equal(await DBOS.getWorkflowStatus(run.runId), null);
          await assert.rejects(emit(run.runId, snapshot([])), /Unknown run/);
          await assert.rejects(finishRun(run.runId, { display: [], context: [] }), /Unknown run/);
          const left = await db
            .select()
            .from(chatRunsTable)
            .where(eq(chatRunsTable.thread_id, child.id));
          assert.equal(left.length, 0);
          await delay(50);
          assert.equal(await DBOS.listWorkflowSteps(run.runId), undefined);
          slow = false;
        },
      );
      await t.test(
        "a dispatched tool is cancelled and drained without a second tool or model dispatch",
        async () => {
          process.env.FIGMA_API_KEY = "offline";
          toolMode = true;
          const child = await openSideChat(parentId, randomUUID(), scope);
          const before = modelCalls;
          const run = await acceptRun(
            {
              threadId: child.id,
              runId: `tool-${randomUUID()}`,
              baseRevision: 0,
              message: { id: "tool-user", text: "read figma" },
            },
            scope,
          );
          await waitFor(async () => toolDispatched);
          await discardSideChat(child.id, scope);
          assert.equal(toolAborted, true);
          assert.equal(modelCalls, before + 1);
          assert.equal(await DBOS.getWorkflowStatus(run.runId), null);
          await assert.rejects(emit(run.runId, snapshot([])), /Unknown run/);
          toolMode = false;
        },
      );
      await t.test(
        "closing cancels an in-flight summary and discards its draft without late parent writes",
        async () => {
          const child = await openSideChat(parentId, randomUUID(), scope);
          const run = await persistRun(
            {
              threadId: child.id,
              runId: `summary-${randomUUID()}`,
              baseRevision: 0,
              message: { id: "summary-user", text: "Original side summary data" },
            },
            scope,
          );
          await finishRun(run.run.runId, { display: run.run.messages, context: run.run.context });
          const before = await hydrateThread(parentId);
          slow = true;
          aborted = false;
          const count = modelCalls;
          const pending = sideChat.request(`/${child.id}/summary`, {
            method: "POST",
            headers: { [SIDE_SCOPE_HEADER]: scope.scope },
          });
          await waitFor(async () => modelCalls > count);
          await discardSideChat(child.id, scope);
          assert.equal(aborted, true);
          assert.equal((await pending).status, 503);
          const [side] = await db
            .select()
            .from(sideChatsTable)
            .where(eq(sideChatsTable.id, child.id));
          assert.equal(side.state, "closed");
          assert.equal(side.draft, null);
          assert.deepEqual(await hydrateThread(parentId), before);
          slow = false;
        },
      );
      await t.test(
        "a new child revision invalidates a draft even after it becomes idle",
        async () => {
          const child = await openSideChat(parentId, randomUUID(), scope);
          const first = await persistRun(
            {
              threadId: child.id,
              runId: `revision-${randomUUID()}`,
              baseRevision: 0,
              message: { id: "revision-user-1", text: "first" },
            },
            scope,
          );
          await finishRun(first.run.runId, {
            display: first.run.messages,
            context: first.run.context,
          });
          const range = await readSideSummaryRange(child.id, scope);
          const draft = await saveSideDraft(child.id, scope, range.epoch, {
            id: randomUUID(),
            sideRevision: range.sideRevision,
            through: range.through,
            text: "old draft",
          });
          const next = await persistRun(
            {
              threadId: child.id,
              runId: `revision-${randomUUID()}`,
              baseRevision: 1,
              message: { id: "revision-user-2", text: "new" },
            },
            scope,
          );
          await finishRun(next.run.runId, {
            display: next.run.messages,
            context: next.run.context,
          });
          await assert.rejects(
            transferSideSummary(child.id, scope, {
              draftId: draft.id,
              transferKey: randomUUID(),
              text: "old draft",
            }),
            /stale/,
          );
          await discardSideChat(child.id, scope);
        },
      );
      await t.test(
        "close and confirmation serialize with exactly one durable outcome",
        async () => {
          const child = await openSideChat(parentId, randomUUID(), scope);
          const run = await persistRun(
            {
              threadId: child.id,
              runId: `race-${randomUUID()}`,
              baseRevision: 0,
              message: { id: "race-user", text: "race" },
            },
            scope,
          );
          await finishRun(run.run.runId, { display: run.run.messages, context: run.run.context });
          const range = await readSideSummaryRange(child.id, scope);
          const draft = await saveSideDraft(child.id, scope, range.epoch, {
            id: randomUUID(),
            sideRevision: range.sideRevision,
            through: range.through,
            text: "race handoff",
          });
          const input = { draftId: draft.id, transferKey: randomUUID(), text: "race handoff" };
          const [transfer, close] = await Promise.allSettled([
            transferSideSummary(child.id, scope, input),
            discardSideChat(child.id, scope),
          ]);
          assert.equal(close.status, "fulfilled");

          if (transfer.status === "fulfilled") {
            const replay = await transferSideSummary(child.id, scope, input);
            assert.deepEqual(replay.receipt, transfer.value.receipt);
            await ensureStarted(transfer.value.run);
            await waitFor(async () => (await hydrateThread(parentId)).activeRun === null);
          } else {
            const receipts = await db
              .select()
              .from(sideTransfersTable)
              .where(eq(sideTransfersTable.transfer_key, input.transferKey));
            assert.equal(receipts.length, 0);
            assert.match(String(transfer.reason), /closed/);
          }

          const [side] = await db
            .select()
            .from(sideChatsTable)
            .where(eq(sideChatsTable.id, child.id));
          assert.equal(side.state, "closed");
        },
      );
      await t.test(
        "expired page leases cannot be renewed or hydrated and are purged by the runtime sweeper",
        async () => {
          const child = await openSideChat(parentId, randomUUID(), scope);
          await db
            .update(sideChatsTable)
            .set({ lease_until: new Date(0) })
            .where(eq(sideChatsTable.id, child.id));
          await heartbeatSideScope(scope);
          await assert.rejects(hydrateThread(child.id, scope), /expired/);
          await waitFor(
            async () =>
              (await db.select().from(sideChatsTable).where(eq(sideChatsTable.id, child.id)))[0]
                ?.state === "closed",
          );
          const [side] = await db
            .select()
            .from(sideChatsTable)
            .where(eq(sideChatsTable.id, child.id));
          assert.equal(side.seed, null);
          assert.equal(side.draft, null);
        },
      );
      await t.test(
        "an accepted main summary survives a failed main model and child disposal",
        async () => {
          const child = await openSideChat(parentId, randomUUID(), scope);
          const run = await persistRun(
            {
              threadId: child.id,
              runId: `failed-transfer-${randomUUID()}`,
              baseRevision: 0,
              message: { id: "failed-transfer-user", text: "saved original" },
            },
            scope,
          );
          await finishRun(run.run.runId, { display: run.run.messages, context: run.run.context });
          const range = await readSideSummaryRange(child.id, scope);
          const draft = await saveSideDraft(child.id, scope, range.epoch, {
            id: randomUUID(),
            sideRevision: range.sideRevision,
            through: range.through,
            text: "Durable accepted summary",
          });
          const input = {
            draftId: draft.id,
            transferKey: randomUUID(),
            text: "Durable accepted summary",
          };
          const accepted = await transferSideSummary(child.id, scope, input);
          await finishRun(accepted.run.runId);
          await discardSideChat(child.id, scope);
          const main = await hydrateThread(parentId);
          assert.equal(main.messages.at(-1)?.id, accepted.receipt.messageId);
          assert.deepEqual(main.messages.at(-1)?.parts, [
            { type: "text", content: "Durable accepted summary" },
          ]);
          assert.deepEqual(
            (await transferSideSummary(child.id, scope, input)).receipt,
            accepted.receipt,
          );
        },
      );
      await t.test("close wins before confirmation and repeated discard converges", async () => {
        const run = await persistRun(
          {
            threadId: second.id,
            runId: `second-${randomUUID()}`,
            baseRevision: 0,
            message: { id: "second-user", text: "second original" },
          },
          scope,
        );
        await finishRun(run.run.runId, { display: run.run.messages, context: run.run.context });
        const range = await readSideSummaryRange(second.id, scope);
        const draft = await saveSideDraft(second.id, scope, range.epoch, {
          id: randomUUID(),
          sideRevision: range.sideRevision,
          through: range.through,
          text: "second draft",
        });
        await discardSideChat(second.id, scope);
        await discardSideChat(second.id, scope);
        await assert.rejects(
          transferSideSummary(second.id, scope, {
            draftId: draft.id,
            transferKey: randomUUID(),
            text: "closed draft",
          }),
          /closed/,
        );
        const response = await sideChat.request(`/open/${parentId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", [SIDE_SCOPE_HEADER]: randomUUID() },
          body: JSON.stringify({ openKey: randomUUID() }),
        });
        assert.equal(response.status, 200);
      });
    } finally {
      provider.mock.restore();
      await shutdownChatRuntime();
    }
  },
);
