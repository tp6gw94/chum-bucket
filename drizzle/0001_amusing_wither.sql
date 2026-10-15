CREATE TABLE "testing_artifacts" (
	"ref" text PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "testing_artifacts_task_id_unique" UNIQUE("task_id")
);
--> statement-breakpoint
CREATE TABLE "testing_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_run_id" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"input" jsonb NOT NULL,
	"input_digest" text NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"cancel_accepted_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"result" jsonb,
	CONSTRAINT "testing_operation_request_unique" UNIQUE("parent_run_id","request_key")
);
--> statement-breakpoint
CREATE TABLE "testing_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "testing_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"child_workflow_id" text NOT NULL,
	"input_digest" text NOT NULL,
	"model_attempts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"native_calls" integer DEFAULT 0 NOT NULL,
	"nested_calls" integer DEFAULT 0 NOT NULL,
	"settled" jsonb,
	CONSTRAINT "testing_tasks_child_workflow_id_unique" UNIQUE("child_workflow_id"),
	CONSTRAINT "testing_task_operation_unique" UNIQUE("operation_id")
);
--> statement-breakpoint
ALTER TABLE "testing_artifacts" ADD CONSTRAINT "testing_artifacts_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_artifacts" ADD CONSTRAINT "testing_artifacts_task_id_testing_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."testing_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_operations" ADD CONSTRAINT "testing_operations_parent_run_id_chat_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."chat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_operations" ADD CONSTRAINT "testing_operations_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_receipts" ADD CONSTRAINT "testing_receipts_task_id_testing_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."testing_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_tasks" ADD CONSTRAINT "testing_tasks_operation_id_testing_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."testing_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "testing_operations_thread_idx" ON "testing_operations" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "testing_receipts_task_idx" ON "testing_receipts" USING btree ("task_id");