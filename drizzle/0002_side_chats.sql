CREATE TABLE "side_chats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"parent_thread_id" uuid NOT NULL,
	"page_scope" uuid NOT NULL,
	"open_key" uuid NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"seed" jsonb,
	"draft" jsonb,
	CONSTRAINT "side_chats_open_key_unique" UNIQUE("page_scope","open_key"),
	CONSTRAINT "side_chats_state_check" CHECK ("side_chats"."state" in ('open', 'closing', 'closed')),
	CONSTRAINT "side_chats_epoch_check" CHECK ("side_chats"."epoch" >= 0)
);
CREATE TABLE "side_transfers" (
	"transfer_key" uuid PRIMARY KEY NOT NULL,
	"page_scope" uuid NOT NULL,
	"digest" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "side_chats_lease_idx" ON "side_chats" USING btree ("state","lease_until");