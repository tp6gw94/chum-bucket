import { sql } from "drizzle-orm";
import type { UIMessage, StreamChunk } from "@tanstack/ai";
import type { RunInput, AcceptedRun } from "../harness/run-store";
import type { RunProjection } from "../harness/conversation";
import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  index,
  integer,
  text,
  primaryKey,
  unique,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const threadsTable = pgTable(
  "threads",
  {
    id: uuid().primaryKey().defaultRandom(),
    title: varchar({ length: 255 }).notNull(),
    agent: varchar({ length: 255 }).notNull().default("default"),
    revision: integer().notNull().default(0),
    active_run_id: text(),
    messages: jsonb().notNull().$type<UIMessage[]>().default([]),
    parent_thread_id: uuid().references((): AnyPgColumn => threadsTable.id),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("threads_updated_at_id_idx").on(t.updated_at, t.id),
    index("threads_parent_thread_id_idx").on(t.parent_thread_id),
    check("threads_revision_nonnegative", sql`${t.revision} >= 0`),
  ],
);

export const chatRunsTable = pgTable(
  "chat_runs",
  {
    id: text().primaryKey(),
    thread_id: uuid()
      .notNull()
      .references(() => threadsTable.id),
    request: jsonb().notNull().$type<RunInput>(),
    accepted: jsonb().notNull().$type<AcceptedRun>(),
    projection: jsonb().notNull().$type<RunProjection | UIMessage[]>(),
    state: text().notNull().$type<"pending" | "succeeded" | "failed">().default("pending"),
    next_sequence: integer().notNull().default(0),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("chat_runs_pending_idx").on(t.state),
    check("chat_runs_state_check", sql`${t.state} in ('pending', 'succeeded', 'failed')`),
    check("chat_runs_sequence_nonnegative", sql`${t.next_sequence} >= 0`),
  ],
);

export const chatEventsTable = pgTable(
  "chat_events",
  {
    run_id: text()
      .notNull()
      .references(() => chatRunsTable.id),
    sequence: integer().notNull(),
    event_key: text().notNull(),
    payload: jsonb().notNull().$type<StreamChunk>(),
  },
  (t) => [
    primaryKey({ columns: [t.run_id, t.sequence] }),
    unique("chat_events_key_unique").on(t.run_id, t.event_key),
    check("chat_events_sequence_nonnegative", sql`${t.sequence} >= 0`),
  ],
);

export const testingOperationsTable = pgTable(
  "testing_operations",
  {
    id: text().primaryKey(),
    parent_run_id: text()
      .notNull()
      .references(() => chatRunsTable.id, { onDelete: "cascade" }),
    thread_id: uuid()
      .notNull()
      .references(() => threadsTable.id, { onDelete: "cascade" }),
    request_key: text().notNull(),
    input: jsonb().notNull().$type<import("../harness/testing-store").TestingInput>(),
    input_digest: text().notNull(),
    deadline: timestamp({ withTimezone: true }).notNull(),
    cancel_accepted_at: timestamp({ withTimezone: true }),
    finished_at: timestamp({ withTimezone: true }),
    outcome: text().$type<"succeeded" | "failed" | "cancelled">(),
    result: jsonb().$type<import("../harness/testing-run").DelegationResult>(),
  },
  (t) => [
    unique("testing_operation_request_unique").on(t.parent_run_id, t.request_key),
    index("testing_operations_thread_idx").on(t.thread_id),
  ],
);

export const testingTasksTable = pgTable(
  "testing_tasks",
  {
    id: text().primaryKey(),
    operation_id: text()
      .notNull()
      .references(() => testingOperationsTable.id, { onDelete: "cascade" }),
    child_workflow_id: text().notNull().unique(),
    input_digest: text().notNull(),
    model_attempts: jsonb().notNull().$type<Record<string, number>>().default({}),
    native_calls: integer().notNull().default(0),
    nested_calls: integer().notNull().default(0),
    settled: jsonb().$type<import("../harness/testing-store").TestingOutput>(),
  },
  (t) => [unique("testing_task_operation_unique").on(t.operation_id)],
);

export const testingArtifactsTable = pgTable("testing_artifacts", {
  ref: text().primaryKey(),
  thread_id: uuid()
    .notNull()
    .references(() => threadsTable.id, { onDelete: "cascade" }),
  task_id: text()
    .notNull()
    .references(() => testingTasksTable.id, { onDelete: "cascade" })
    .unique(),
  payload: jsonb().notNull().$type<import("../../shared/testing").Artifact>(),
});

export const testingReceiptsTable = pgTable(
  "testing_receipts",
  {
    id: text().primaryKey(),
    task_id: text()
      .notNull()
      .references(() => testingTasksTable.id, { onDelete: "cascade" }),
    payload: jsonb().notNull().$type<import("../../shared/testing").Receipt>(),
  },
  (t) => [index("testing_receipts_task_idx").on(t.task_id)],
);
