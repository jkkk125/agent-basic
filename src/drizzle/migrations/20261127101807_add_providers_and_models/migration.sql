CREATE TABLE `models` (
	`id` text PRIMARY KEY,
	`provider_id` text NOT NULL,
	`name` text NOT NULL UNIQUE,
	`model_id` text NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_models_provider_id_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL UNIQUE,
	`base_url` text NOT NULL,
	`api_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `agent_usage` ADD `model` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_models_single_active` ON `models` (`is_active`) WHERE "models"."is_active" = 1;