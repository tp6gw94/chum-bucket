CREATE TABLE "testing_artifacts" (
	"ref" text PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"role" text NOT NULL,
	"kind" text NOT NULL,
	"scope_digest" text NOT NULL,
	"payload_digest" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "testing_decisions" (
	"operation_id" text NOT NULL,
	"decision_index" integer NOT NULL,
	"decision_key" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "testing_decisions_operation_id_decision_index_pk" PRIMARY KEY("operation_id","decision_index"),
	CONSTRAINT "testing_decisions_key_unique" UNIQUE("operation_id","decision_key")
);
--> statement-breakpoint
CREATE TABLE "testing_deliveries" (
	"delivery_key" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"task_id" text NOT NULL,
	"kind" text NOT NULL,
	"acknowledgement" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "testing_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_run_id" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"role" text NOT NULL,
	"intent" jsonb NOT NULL,
	"runtime" jsonb NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"cancel_accepted_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"terminal_outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "testing_operations_request_unique" UNIQUE("parent_run_id","request_key")
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
	"digest" text NOT NULL,
	"view" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "testing_publications_operation_id_version_pk" PRIMARY KEY("operation_id","version")
);
--> statement-breakpoint
CREATE TABLE "testing_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"slot" text NOT NULL,
	"native_name" text NOT NULL,
	"route" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb NOT NULL,
	"input_digest" text NOT NULL,
	"output_digest" text NOT NULL,
	"bindings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "testing_receipts_slot_unique" UNIQUE("task_id","attempt","slot","native_name")
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
	"model_steps" integer DEFAULT 0 NOT NULL,
	"native_calls" integer DEFAULT 0 NOT NULL,
	"nested_calls" integer DEFAULT 0 NOT NULL,
	"step_attempts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activity" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "testing_tasks_role_unique" UNIQUE("operation_id","role"),
	CONSTRAINT "testing_tasks_workflow_unique" UNIQUE("child_workflow_id")
);
--> statement-breakpoint
ALTER TABLE "testing_artifacts" ADD CONSTRAINT "testing_artifacts_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_artifacts" ADD CONSTRAINT "testing_artifacts_operation_id_testing_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."testing_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_decisions" ADD CONSTRAINT "testing_decisions_operation_id_testing_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."testing_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_deliveries" ADD CONSTRAINT "testing_deliveries_operation_id_testing_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."testing_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_deliveries" ADD CONSTRAINT "testing_deliveries_task_id_testing_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."testing_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_operations" ADD CONSTRAINT "testing_operations_parent_run_id_chat_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."chat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_operations" ADD CONSTRAINT "testing_operations_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_pins" ADD CONSTRAINT "testing_pins_operation_id_testing_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."testing_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_pins" ADD CONSTRAINT "testing_pins_ref_testing_artifacts_ref_fk" FOREIGN KEY ("ref") REFERENCES "public"."testing_artifacts"("ref") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_publications" ADD CONSTRAINT "testing_publications_operation_id_testing_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."testing_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_receipts" ADD CONSTRAINT "testing_receipts_task_id_testing_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."testing_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_tasks" ADD CONSTRAINT "testing_tasks_operation_id_testing_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."testing_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "testing_artifacts_thread_idx" ON "testing_artifacts" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "testing_operations_thread_idx" ON "testing_operations" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "testing_operations_open_idx" ON "testing_operations" USING btree ("finished_at");--> statement-breakpoint
CREATE INDEX "testing_receipts_task_idx" ON "testing_receipts" USING btree ("task_id");