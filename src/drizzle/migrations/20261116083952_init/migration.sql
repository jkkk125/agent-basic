CREATE TABLE `agent_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`session_id` text NOT NULL,
	`response_id` text,
	`position` integer NOT NULL,
	`type` text NOT NULL,
	`role` text,
	`tool_name` text,
	`call_id` text,
	`item` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_agent_messages_session_id_agent_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`),
	CONSTRAINT `agent_messages_session_id_position_unique` UNIQUE(`session_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY,
	`name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`session_id` text NOT NULL,
	`response_id` text,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`total_tokens` integer NOT NULL,
	`input_tokens_details` text NOT NULL,
	`output_tokens_details` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_agent_usage_session_id_agent_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`)
);
