import { sql } from "drizzle-orm";
import type { UIMessage, StreamChunk } from "@tanstack/ai";
import type { RunInput, AcceptedRun } from "../harness/run-store";
import type { RunProjection } from "../harness/conversation";
import type { DelegationInput, OperationOutcome, Role, TestView } from "../../shared/testing";
import type { OperationRuntime, TaskActivity } from "../harness/testing-store";
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
    context_anchor: text(),
    parent_thread_id: uuid().references((): AnyPgColumn => threadsTable.id),
    closed_at: timestamp({ withTimezone: true }),
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
    projection: jsonb().notNull().$type<RunProjection>(),
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
      .references(() => chatRunsTable.id),
    thread_id: uuid()
      .notNull()
      .references(() => threadsTable.id),
    request_key: text().notNull(),
    role: text().notNull().$type<Role>(),
    intent: jsonb().notNull().$type<DelegationInput>(),
    runtime: jsonb().notNull().$type<OperationRuntime>(),
    deadline: timestamp({ withTimezone: true }).notNull(),
    cancel_accepted_at: timestamp({ withTimezone: true }),
    finished_at: timestamp({ withTimezone: true }),
    terminal_outcome: text().$type<OperationOutcome>(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("testing_operations_request_unique").on(t.parent_run_id, t.request_key),
    index("testing_operations_thread_idx").on(t.thread_id),
    index("testing_operations_open_idx").on(t.finished_at),
  ],
);

export const testingTasksTable = pgTable(
  "testing_tasks",
  {
    id: text().primaryKey(),
    operation_id: text()
      .notNull()
      .references(() => testingOperationsTable.id),
    role: text().notNull().$type<Role>(),
    child_workflow_id: text().notNull(),
    attempt_nonce: integer().notNull(),
    input_digest: text().notNull(),
    input: jsonb().notNull(),
    model_steps: integer().notNull().default(0),
    native_calls: integer().notNull().default(0),
    nested_calls: integer().notNull().default(0),
    step_attempts: jsonb().notNull().$type<Record<string, number>>().default({}),
    activity: jsonb().$type<TaskActivity>(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("testing_tasks_role_unique").on(t.operation_id, t.role),
    unique("testing_tasks_workflow_unique").on(t.child_workflow_id),
  ],
);

export const testingDecisionsTable = pgTable(
  "testing_decisions",
  {
    operation_id: text()
      .notNull()
      .references(() => testingOperationsTable.id),
    decision_index: integer().notNull(),
    decision_key: text().notNull(),
    kind: text().notNull(),
    payload: jsonb().notNull(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.operation_id, t.decision_index] }),
    unique("testing_decisions_key_unique").on(t.operation_id, t.decision_key),
  ],
);

export const testingArtifactsTable = pgTable(
  "testing_artifacts",
  {
    ref: text().primaryKey(),
    thread_id: uuid()
      .notNull()
      .references(() => threadsTable.id),
    operation_id: text()
      .notNull()
      .references(() => testingOperationsTable.id),
    role: text().notNull().$type<Role>(),
    kind: text().notNull(),
    scope_digest: text().notNull(),
    payload_digest: text().notNull(),
    metadata: jsonb().notNull(),
    payload: jsonb().notNull(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("testing_artifacts_thread_idx").on(t.thread_id)],
);

export const testingDeliveriesTable = pgTable("testing_deliveries", {
  delivery_key: text().primaryKey(),
  operation_id: text()
    .notNull()
    .references(() => testingOperationsTable.id),
  task_id: text()
    .notNull()
    .references(() => testingTasksTable.id),
  kind: text().notNull().$type<"start" | "cancel">(),
  acknowledgement: text()
    .notNull()
    .$type<"pending" | "running" | "cancel_requested" | "stopped" | "quiet">(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const testingPinsTable = pgTable(
  "testing_pins",
  {
    operation_id: text()
      .notNull()
      .references(() => testingOperationsTable.id),
    ref: text()
      .notNull()
      .references(() => testingArtifactsTable.ref),
  },
  (t) => [primaryKey({ columns: [t.operation_id, t.ref] })],
);

export const testingPublicationsTable = pgTable(
  "testing_publications",
  {
    operation_id: text()
      .notNull()
      .references(() => testingOperationsTable.id),
    version: integer().notNull(),
    digest: text().notNull(),
    view: jsonb().notNull().$type<TestView>(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.operation_id, t.version] })],
);

export const testingReceiptsTable = pgTable(
  "testing_receipts",
  {
    id: text().primaryKey(),
    task_id: text()
      .notNull()
      .references(() => testingTasksTable.id),
    attempt: integer().notNull(),
    slot: text().notNull(),
    native_name: text().notNull(),
    route: text().notNull(),
    input: jsonb().notNull(),
    output: jsonb().notNull(),
    input_digest: text().notNull(),
    output_digest: text().notNull(),
    bindings: jsonb().notNull().$type<Record<string, string>>(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("testing_receipts_slot_unique").on(t.task_id, t.attempt, t.slot, t.native_name),
    index("testing_receipts_task_idx").on(t.task_id),
  ],
);
