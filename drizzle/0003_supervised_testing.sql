CREATE TABLE "testing_artifacts" (
	"ref" text PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"original_operation_id" text NOT NULL,
	"role" text NOT NULL,
	"kind" text NOT NULL,
	"scope_digest" text NOT NULL,
	"payload_digest" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"validation_receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "testing_artifacts_role_check" CHECK ("testing_artifacts"."role" in ('atlassian', 'planner', 'ac', 'ui')),
	CONSTRAINT "testing_artifacts_kind_check" CHECK ("testing_artifacts"."kind" in ('requirements', 'plan', 'ac-result', 'ui-result'))
);
--> statement-breakpoint
CREATE TABLE "testing_decisions" (
	"operation_id" text NOT NULL,
	"decision_index" integer NOT NULL,
	"decision_key" text NOT NULL,
	"body" jsonb NOT NULL,
	CONSTRAINT "testing_decisions_operation_id_decision_index_pk" PRIMARY KEY("operation_id","decision_index"),
	CONSTRAINT "testing_decisions_key_unique" UNIQUE("operation_id","decision_key"),
	CONSTRAINT "testing_decisions_index_nonnegative" CHECK ("testing_decisions"."decision_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "testing_deliveries" (
	"delivery_key" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"task_id" text NOT NULL,
	"kind" text NOT NULL,
	"acknowledgement" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acked_at" timestamp with time zone,
	CONSTRAINT "testing_deliveries_kind_check" CHECK ("testing_deliveries"."kind" in ('start', 'cancel')),
	CONSTRAINT "testing_deliveries_ack_check" CHECK ("testing_deliveries"."acknowledgement" is null or "testing_deliveries"."acknowledgement" in ('quiet', 'cancel_requested', 'stopped'))
);
--> statement-breakpoint
CREATE TABLE "testing_observations" (
	"task_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"seq" integer NOT NULL,
	"observation_key" text NOT NULL,
	"safe_body" jsonb NOT NULL,
	"bytes" integer NOT NULL,
	CONSTRAINT "testing_observations_task_id_attempt_seq_pk" PRIMARY KEY("task_id","attempt","seq"),
	CONSTRAINT "testing_observations_key_unique" UNIQUE("task_id","observation_key"),
	CONSTRAINT "testing_observations_attempt_check" CHECK ("testing_observations"."attempt" >= 1),
	CONSTRAINT "testing_observations_seq_nonnegative" CHECK ("testing_observations"."seq" >= 0),
	CONSTRAINT "testing_observations_bytes_positive" CHECK ("testing_observations"."bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "testing_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_run_id" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"intent" jsonb NOT NULL,
	"runtime" jsonb NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"writer_nonce" integer DEFAULT 0 NOT NULL,
	"cancel_accepted_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"terminal_outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "testing_operations_request_key_unique" UNIQUE("parent_run_id","request_key"),
	CONSTRAINT "testing_operations_writer_nonce_nonnegative" CHECK ("testing_operations"."writer_nonce" >= 0),
	CONSTRAINT "testing_operations_terminal_outcome_check" CHECK ("testing_operations"."terminal_outcome" is null or "testing_operations"."terminal_outcome" in ('completed', 'failed', 'cancelled', 'missing', 'incompatible', 'timed_out')),
	CONSTRAINT "testing_operations_terminal_pair_check" CHECK (("testing_operations"."finished_at" is null and "testing_operations"."terminal_outcome" is null) or ("testing_operations"."finished_at" is not null and "testing_operations"."terminal_outcome" is not null))
);
--> statement-breakpoint
CREATE TABLE "testing_pins" (
	"operation_id" text NOT NULL,
	"ref" text NOT NULL,
	CONSTRAINT "testing_pins_operation_id_ref_pk" PRIMARY KEY("operation_id","ref")
);
--> statement-breakpoint
CREATE TABLE "testing_publications" (
	"operation_id" text NOT NULL,
	"version" integer NOT NULL,
	"root_event_key" text NOT NULL,
	"public_sequence" integer NOT NULL,
	"view" jsonb NOT NULL,
	"cursors" jsonb NOT NULL,
	CONSTRAINT "testing_publications_operation_id_version_pk" PRIMARY KEY("operation_id","version"),
	CONSTRAINT "testing_publications_event_unique" UNIQUE("operation_id","root_event_key"),
	CONSTRAINT "testing_publications_version_nonnegative" CHECK ("testing_publications"."version" >= 0),
	CONSTRAINT "testing_publications_sequence_nonnegative" CHECK ("testing_publications"."public_sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "testing_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"slot" text NOT NULL,
	"native_name" text NOT NULL,
	"route" text NOT NULL,
	"input_digest" text NOT NULL,
	"output_digest" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb NOT NULL,
	"bindings" jsonb NOT NULL,
	CONSTRAINT "testing_receipts_slot_unique" UNIQUE("task_id","attempt","slot","native_name"),
	CONSTRAINT "testing_receipts_attempt_check" CHECK ("testing_receipts"."attempt" >= 1),
	CONSTRAINT "testing_receipts_route_check" CHECK ("testing_receipts"."route" in ('direct', 'codemode'))
);
--> statement-breakpoint
CREATE TABLE "testing_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"role" text NOT NULL,
	"child_workflow_id" text NOT NULL,
	"attempt_nonce" integer NOT NULL,
	"input_digest" text NOT NULL,
	"input" jsonb NOT NULL,
	"runtime" jsonb NOT NULL,
	"model_steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"native_calls" integer DEFAULT 0 NOT NULL,
	"nested_calls" integer DEFAULT 0 NOT NULL,
	"io_sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "testing_tasks_role_unique" UNIQUE("operation_id","role"),
	CONSTRAINT "testing_tasks_child_unique" UNIQUE("child_workflow_id"),
	CONSTRAINT "testing_tasks_role_check" CHECK ("testing_tasks"."role" in ('atlassian', 'planner', 'ac', 'ui')),
	CONSTRAINT "testing_tasks_attempt_check" CHECK ("testing_tasks"."attempt_nonce" >= 1),
	CONSTRAINT "testing_tasks_native_calls_nonnegative" CHECK ("testing_tasks"."native_calls" >= 0),
	CONSTRAINT "testing_tasks_nested_calls_nonnegative" CHECK ("testing_tasks"."nested_calls" >= 0),
	CONSTRAINT "testing_tasks_io_sequence_nonnegative" CHECK ("testing_tasks"."io_sequence" >= 0)
);
--> statement-breakpoint
ALTER TABLE "testing_artifacts" ADD CONSTRAINT "testing_artifacts_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_artifacts" ADD CONSTRAINT "testing_artifacts_original_operation_id_testing_operations_id_fk" FOREIGN KEY ("original_operation_id") REFERENCES "public"."testing_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_decisions" ADD CONSTRAINT "testing_decisions_operation_id_testing_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."testing_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_deliveries" ADD CONSTRAINT "testing_deliveries_operation_id_testing_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."testing_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_deliveries" ADD CONSTRAINT "testing_deliveries_task_id_testing_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."testing_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_observations" ADD CONSTRAINT "testing_observations_task_id_testing_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."testing_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_operations" ADD CONSTRAINT "testing_operations_parent_run_id_chat_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."chat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_operations" ADD CONSTRAINT "testing_operations_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_pins" ADD CONSTRAINT "testing_pins_operation_id_testing_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."testing_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_pins" ADD CONSTRAINT "testing_pins_ref_testing_artifacts_ref_fk" FOREIGN KEY ("ref") REFERENCES "public"."testing_artifacts"("ref") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_publications" ADD CONSTRAINT "testing_publications_operation_id_testing_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."testing_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_receipts" ADD CONSTRAINT "testing_receipts_task_id_testing_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."testing_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_tasks" ADD CONSTRAINT "testing_tasks_operation_id_testing_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."testing_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "testing_artifacts_thread_kind_idx" ON "testing_artifacts" USING btree ("thread_id","kind");--> statement-breakpoint
CREATE INDEX "testing_deliveries_operation_idx" ON "testing_deliveries" USING btree ("operation_id","kind");--> statement-breakpoint
CREATE INDEX "testing_operations_parent_idx" ON "testing_operations" USING btree ("parent_run_id");