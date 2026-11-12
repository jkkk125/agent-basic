CREATE TABLE "agent_messages" (
	"id" serial PRIMARY KEY,
	"content" text,
	"role" text,
	"created_at" timestamp DEFAULT now()
);
