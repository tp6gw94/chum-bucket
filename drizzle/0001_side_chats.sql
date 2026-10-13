CREATE TABLE "side_chats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"parent_thread_id" uuid NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"seed" jsonb NOT NULL,
	CONSTRAINT "side_chats_state_check" CHECK ("side_chats"."state" in ('open', 'closing'))
);
