import { TestingRequestError, type ReuseDecision, type TestView } from "../../shared/testing";
import { cancelPublishedTesting, readPublishedTesting, RunRequestError } from "./run-store";
import { TestingPersistenceError } from "./testing-store";

export type TestingProblem = Readonly<{
  status: 400 | 404 | 409;
  message: string;
  decisions?: readonly ReuseDecision[];
}>;

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
