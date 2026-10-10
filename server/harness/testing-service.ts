import {
  TestingRequestError,
  testingRequestSchema,
  type ReuseDecision,
  type TestingRequest,
  type TestView,
} from "../../shared/testing";
import {
  admitStandaloneTesting,
  cancelPublishedTesting,
  publishProjection,
  readPublishedTesting,
  RunRequestError,
} from "./run-store";
import { ensureTestingRoot } from "./testing-run";
import { TestingPersistenceError } from "./testing-store";

export type TestingProblem = Readonly<{
  status: 400 | 404 | 409;
  message: string;
  decisions?: readonly ReuseDecision[];
}>;

export async function request(input: TestingRequest): Promise<TestView> {
  const parsed = testingRequestSchema.parse(input);
  const admission = await admitStandaloneTesting(parsed);
  await ensureTestingRoot(admission.parentRunId, admission.operationId);

  return publishProjection(admission.parentRunId, admission.operationId);
}

export async function read(threadId: string, runId: string): Promise<TestView> {
  const view = await readPublishedTesting(threadId, runId);

  if (!view) {
    throw new TestingPersistenceError(404, "Testing run was not found");
  }

  return view;
}

export async function cancel(threadId: string, runId: string): Promise<TestView> {
  return cancelPublishedTesting(threadId, runId);
}

export function problem(error: unknown): TestingProblem | null {
  if (error instanceof TestingRequestError) {
    return {
      status: 400,
      message: error.message,
      ...(error.decisions ? { decisions: error.decisions } : {}),
    };
  }

  if (error instanceof TestingPersistenceError || error instanceof RunRequestError) {
    return {
      status: error.status,
      message: error.message,
    };
  }

  return null;
}
