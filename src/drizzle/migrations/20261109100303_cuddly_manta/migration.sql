CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN "session_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN "position" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN "type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN "tool_name" text;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN "call_id" text;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN "preview" text;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN "item" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_messages" DROP COLUMN "content";--> statement-breakpoint
ALTER TABLE "agent_messages" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at"::timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_messages" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_session_id_position_unique" UNIQUE("session_id","position");--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_session_id_agent_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id");