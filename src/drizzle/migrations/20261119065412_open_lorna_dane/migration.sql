ALTER TABLE `agent_usage` ADD `source` text DEFAULT 'agent_round' NOT NULL;--> statement-breakpoint
UPDATE `agent_usage` SET `source` = 'session_title' WHERE `input_item_count` IS NULL;
