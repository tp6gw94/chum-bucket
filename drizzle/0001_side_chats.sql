CREATE TABLE "side_chats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"parent_thread_id" uuid NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"seed" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "side_chats_state_check" CHECK ("side_chats"."state" in ('open', 'closing'))
);
--> statement-breakpoint
ALTER TABLE "side_chats" ADD CONSTRAINT "side_chats_id_threads_id_fk" FOREIGN KEY ("id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "side_chats" ADD CONSTRAINT "side_chats_parent_thread_id_threads_id_fk" FOREIGN KEY ("parent_thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "side_chats_parent_thread_id_idx" ON "side_chats" USING btree ("parent_thread_id");