CREATE TABLE "chat_events" (
	"run_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"event_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "chat_events_run_id_sequence_pk" PRIMARY KEY("run_id","sequence"),
	CONSTRAINT "chat_events_key_unique" UNIQUE("run_id","event_key"),
	CONSTRAINT "chat_events_sequence_nonnegative" CHECK ("chat_events"."sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "chat_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"accepted" jsonb NOT NULL,
	"projection" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"next_sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_runs_state_check" CHECK ("chat_runs"."state" in ('pending', 'succeeded', 'failed')),
	CONSTRAINT "chat_runs_sequence_nonnegative" CHECK ("chat_runs"."next_sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(255) NOT NULL,
	"agent" varchar(255) DEFAULT 'default' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"active_run_id" text,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"parent_thread_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_revision_nonnegative" CHECK ("threads"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_run_id_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."chat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_runs" ADD CONSTRAINT "chat_runs_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_parent_thread_id_threads_id_fk" FOREIGN KEY ("parent_thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_runs_pending_idx" ON "chat_runs" USING btree ("state");--> statement-breakpoint
CREATE INDEX "threads_updated_at_id_idx" ON "threads" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "threads_parent_thread_id_idx" ON "threads" USING btree ("parent_thread_id");