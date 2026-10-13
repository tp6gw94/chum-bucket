import { sql } from "drizzle-orm";
import type { UIMessage, StreamChunk } from "@tanstack/ai";
import type { RunProjection } from "../harness/conversation";
import type { RunInput, AcceptedRun } from "../harness/run-store";
import type { SideChatSeed } from "../../shared/side-chat";
import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  index,
  integer,
  text,
  boolean,
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

export const sideChatsTable = pgTable(
  "side_chats",
  {
    id: uuid().primaryKey(),
    parent_thread_id: uuid().notNull(),
    state: text().notNull().$type<"open" | "closing">().default("open"),
    seed: jsonb().notNull().$type<SideChatSeed>(),
  },
  (t) => [check("side_chats_state_check", sql`${t.state} in ('open', 'closing')`)],
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
    log_bytes: integer().notNull().default(0),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("chat_runs_pending_idx").on(t.state),
    check("chat_runs_state_check", sql`${t.state} in ('pending', 'succeeded', 'failed')`),
    check("chat_runs_sequence_nonnegative", sql`${t.next_sequence} >= 0`),
  ],
);

export const chatModelSlotsTable = pgTable(
  "chat_model_slots",
  {
    run_id: text()
      .notNull()
      .references(() => chatRunsTable.id),
    turn: integer().notNull(),
    epoch: integer().notNull().default(0),
    committed: boolean().notNull().default(false),
    receipt: jsonb(),
  },
  (t) => [
    primaryKey({ columns: [t.run_id, t.turn] }),
    check("chat_model_slots_turn_check", sql`${t.turn} >= 0 and ${t.turn} < 5`),
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
    intent: jsonb().notNull(),
    runtime: jsonb().notNull(),
    deadline: timestamp({ withTimezone: true }).notNull(),
    writer_nonce: integer().notNull().default(0),
    cancel_accepted_at: timestamp({ withTimezone: true }),
    finished_at: timestamp({ withTimezone: true }),
    terminal_outcome: text(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("testing_operations_request_key_unique").on(t.parent_run_id, t.request_key),
    index("testing_operations_parent_idx").on(t.parent_run_id),
    check("testing_operations_writer_nonce_nonnegative", sql`${t.writer_nonce} >= 0`),
    check(
      "testing_operations_terminal_outcome_check",
      sql`${t.terminal_outcome} is null or ${t.terminal_outcome} in ('completed', 'failed', 'cancelled', 'missing', 'incompatible', 'timed_out')`,
    ),
    check(
      "testing_operations_terminal_pair_check",
      sql`(${t.finished_at} is null and ${t.terminal_outcome} is null) or (${t.finished_at} is not null and ${t.terminal_outcome} is not null)`,
    ),
  ],
);

export const testingArtifactsTable = pgTable(
  "testing_artifacts",
  {
    ref: text().primaryKey(),
    thread_id: uuid()
      .notNull()
      .references(() => threadsTable.id),
    original_operation_id: text()
      .notNull()
      .references(() => testingOperationsTable.id),
    role: text().notNull(),
    kind: text().notNull(),
    scope_digest: text().notNull(),
    payload_digest: text().notNull(),
    metadata: jsonb().notNull(),
    payload: jsonb().notNull(),
    validation_receipt: jsonb().notNull(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("testing_artifacts_thread_kind_idx").on(t.thread_id, t.kind),
    check("testing_artifacts_role_check", sql`${t.role} in ('atlassian', 'planner', 'ac', 'ui')`),
    check(
      "testing_artifacts_kind_check",
      sql`${t.kind} in ('requirements', 'plan', 'ac-result', 'ui-result')`,
    ),
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
    body: jsonb().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.operation_id, t.decision_index] }),
    unique("testing_decisions_key_unique").on(t.operation_id, t.decision_key),
    check("testing_decisions_index_nonnegative", sql`${t.decision_index} >= 0`),
  ],
);

export const testingPinsTable = pgTable(
  "testing_pins",
  {
    operation_id: text()
      .notNull()
      .references(() => testingOperationsTable.id),
    ref: text()
      .notNull()
      .references(() => testingArtifactsTable.ref, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [t.operation_id, t.ref] })],
);

export const testingTasksTable = pgTable(
  "testing_tasks",
  {
    id: text().primaryKey(),
    operation_id: text()
      .notNull()
      .references(() => testingOperationsTable.id),
    role: text().notNull(),
    child_workflow_id: text().notNull(),
    attempt_nonce: integer().notNull(),
    input_digest: text().notNull(),
    input: jsonb().notNull(),
    runtime: jsonb().notNull(),
    model_steps: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    native_calls: integer().notNull().default(0),
    nested_calls: integer().notNull().default(0),
    io_sequence: integer().notNull().default(0),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("testing_tasks_role_unique").on(t.operation_id, t.role),
    unique("testing_tasks_child_unique").on(t.child_workflow_id),
    check("testing_tasks_role_check", sql`${t.role} in ('atlassian', 'planner', 'ac', 'ui')`),
    check("testing_tasks_attempt_check", sql`${t.attempt_nonce} >= 1`),
    check("testing_tasks_native_calls_nonnegative", sql`${t.native_calls} >= 0`),
    check("testing_tasks_nested_calls_nonnegative", sql`${t.nested_calls} >= 0`),
    check("testing_tasks_io_sequence_nonnegative", sql`${t.io_sequence} >= 0`),
  ],
);

export const testingObservationsTable = pgTable(
  "testing_observations",
  {
    task_id: text()
      .notNull()
      .references(() => testingTasksTable.id),
    attempt: integer().notNull(),
    seq: integer().notNull(),
    observation_key: text().notNull(),
    safe_body: jsonb().notNull(),
    bytes: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.task_id, t.attempt, t.seq] }),
    unique("testing_observations_key_unique").on(t.task_id, t.observation_key),
    check("testing_observations_attempt_check", sql`${t.attempt} >= 1`),
    check("testing_observations_seq_nonnegative", sql`${t.seq} >= 0`),
    check("testing_observations_bytes_positive", sql`${t.bytes} > 0`),
  ],
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
    input_digest: text().notNull(),
    output_digest: text().notNull(),
    input: jsonb().notNull(),
    output: jsonb().notNull(),
    bindings: jsonb().notNull(),
  },
  (t) => [
    unique("testing_receipts_slot_unique").on(t.task_id, t.attempt, t.slot, t.native_name),
    check("testing_receipts_attempt_check", sql`${t.attempt} >= 1`),
    check("testing_receipts_route_check", sql`${t.route} in ('direct', 'codemode')`),
  ],
);

export const testingDeliveriesTable = pgTable(
  "testing_deliveries",
  {
    delivery_key: text().primaryKey(),
    operation_id: text()
      .notNull()
      .references(() => testingOperationsTable.id),
    task_id: text()
      .notNull()
      .references(() => testingTasksTable.id),
    kind: text().notNull(),
    acknowledgement: text(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    acked_at: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("testing_deliveries_operation_idx").on(t.operation_id, t.kind),
    check("testing_deliveries_kind_check", sql`${t.kind} in ('start', 'cancel')`),
    check(
      "testing_deliveries_ack_check",
      sql`${t.acknowledgement} is null or ${t.acknowledgement} in ('quiet', 'cancel_requested', 'stopped')`,
    ),
  ],
);

export const testingPublicationsTable = pgTable(
  "testing_publications",
  {
    operation_id: text()
      .notNull()
      .references(() => testingOperationsTable.id),
    version: integer().notNull(),
    root_event_key: text().notNull(),
    public_sequence: integer().notNull(),
    view: jsonb().notNull(),
    cursors: jsonb().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.operation_id, t.version] }),
    unique("testing_publications_event_unique").on(t.operation_id, t.root_event_key),
    check("testing_publications_version_nonnegative", sql`${t.version} >= 0`),
    check("testing_publications_sequence_nonnegative", sql`${t.public_sequence} >= 0`),
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
