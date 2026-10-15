ALTER TABLE "threads" ADD COLUMN "context_anchor" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "closed_at" timestamp with time zone;