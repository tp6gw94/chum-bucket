import { sql } from "drizzle-orm";
import type { UIMessage, StreamChunk } from "@tanstack/ai";
import type { RunInput, AcceptedRun } from "../harness/run-store";
import type { RunProjection } from "../harness/conversation";
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
