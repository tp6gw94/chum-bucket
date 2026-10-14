import {
  chat,
  chatParamsFromRequestBody,
  modelMessagesToUIMessages,
  toServerSentEventsResponse,
  type ChatMiddleware,
} from "@tanstack/ai";
import { deepinfra } from "@server/harness/provider";
import { openuiInstructions } from "@server/harness/prompts";
import { figmaTools } from "@server/harness/tools/figma";
import { jiraTools } from "@server/harness/tools/jira";
import { Hono } from "hono";
import { db } from "./db";
import { threadsTable } from "./db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";

const app = new Hono();

const updateChatMessage: ChatMiddleware = {
  name: "updateChatMessage",
  onFinish: async (context) => {
    const messages = modelMessagesToUIMessages([...context.messages]);
    const title =
      messages
        .find((message) => message.role === "user")
        ?.parts.filter((part) => part.type === "text")
        .map((part) => part.content)
        .join("")
        .slice(0, 10) || "新對話";
    await db
      .update(threadsTable)
      .set({ messages, title, updated_at: new Date() })
      .where(eq(threadsTable.id, context.threadId));
  },
};

const forceRunId = (runId: string): ChatMiddleware => ({
  name: "forceRunId",
  onChunk: (_context, chunk) => ("runId" in chunk ? { ...chunk, runId } : chunk),
});

app.get("/", async (c) => {
  const threadId = c.req.query("threadId");

  if (!z.uuid().safeParse(threadId).success) {
    return c.json({ error: "Invalid thread id" }, 400);
  }

  const [thread] = await db
    .select({ messages: threadsTable.messages })
    .from(threadsTable)
    .where(eq(threadsTable.id, threadId!));

  return thread ? c.json({ messages: thread.messages, activeRun: null }) : c.notFound();
});

app.post("/", async (c) => {
  const payload = await chatParamsFromRequestBody(await c.req.json());

  const stream = chat({
    adapter: deepinfra("deepseek-ai/DeepSeek-V4.1-Flash"),
    systemPrompts: [openuiInstructions()],
    messages: payload.messages,
    threadId: payload.threadId,
    runId: payload.runId,
    middleware: [forceRunId(payload.runId), updateChatMessage],
    tools: [...figmaTools, ...jiraTools],
  });

  return toServerSentEventsResponse(stream);
});

export default app;
