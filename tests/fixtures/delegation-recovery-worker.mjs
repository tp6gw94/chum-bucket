import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { launchChatRuntime, shutdownChatRuntime, ensureStarted } from "../../server/harness/run.ts";
import { persistRun, hydrateThread } from "../../server/harness/run-store.ts";
import threadApp from "../../server/thread.ts";

await launchChatRuntime();
let threadId = process.env.DELEGATION_RECOVERY_THREAD;
if (!threadId) {
  const response = await threadApp.request("/", {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" },
  });
  const thread = await response.json();
  threadId = thread.id;
  console.log(`RECOVERY_THREAD ${threadId}`);
  const intent = {
    goal: "Verify checkout",
    sources: [{ kind: "jira", issueKey: "CHUM-42" }],
  };
  const parent = await persistRun({
    threadId,
    runId: `recovery-${randomUUID()}`,
    baseRevision: 0,
    message: { id: "recovery-input", text: `fixture ${JSON.stringify(intent)}` },
  });
  await ensureStarted(parent.run);
}
let state = await hydrateThread(threadId);
for (
  let attempt = 0;
  attempt < Number(process.env.DELEGATION_RECOVERY_ATTEMPTS ?? "600") && state.activeRun;
  attempt += 1
) {
  await delay(100);
  state = await hydrateThread(threadId);
}
if (state.activeRun) throw new Error("Recovery did not converge");
console.log(`RECOVERED ${JSON.stringify(state.publishedTasks)}`);
console.log(`RECOVERED_MESSAGES ${JSON.stringify(state.messages)}`);
await shutdownChatRuntime();
process.exit(0);
