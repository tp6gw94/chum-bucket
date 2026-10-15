import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { cancelTestingSchema } from "../shared/testing";
import { RunRequestError } from "./harness/run-store";
import { operationView, publishOperation, requestCancel } from "./harness/testing-store";

const app = new Hono();
app.use(
  "*",
  bodyLimit({ maxSize: 4_000, onError: (c) => c.json({ error: "Request too large" }, 413) }),
);

const operationIdSchema = z.string().regex(/^testing-[0-9a-f]{32}$/);

function operationIdOf(value: string): string {
  const parsed = operationIdSchema.safeParse(value);

  if (!parsed.success) {
    throw new RunRequestError(400, "Invalid testing run ID");
  }

  return parsed.data;
}

function threadIdOf(value: string | undefined): string {
  const parsed = z.uuid().safeParse(value);

  if (!parsed.success) {
    throw new RunRequestError(400, "Invalid thread ID");
  }

  return parsed.data;
}

app.onError((error, c) => {
  if (error instanceof RunRequestError) {
    return c.json({ error: error.message }, error.status);
  }

  console.error("Testing request failed", error);

  return c.json({ error: "Testing service unavailable" }, 503);
});

app.get("/:runId", async (c) =>
  c.json(
    await operationView(operationIdOf(c.req.param("runId")), threadIdOf(c.req.query("threadId"))),
  ),
);

app.post("/:runId/cancel", async (c) => {
  const operationId = operationIdOf(c.req.param("runId"));
  const body = cancelTestingSchema.safeParse(await c.req.json().catch(() => null));

  if (!body.success) {
    throw new RunRequestError(400, "A thread ID is required");
  }

  const result = await requestCancel(operationId, body.data.threadId);
  const view = await publishOperation(operationId);

  return c.json({ ...result, view });
});

export default app;
