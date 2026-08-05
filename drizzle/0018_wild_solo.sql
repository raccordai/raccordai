CREATE TABLE `voice_personas` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`voice_id` text NOT NULL,
	`description` text,
	`niche_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`niche_id`) REFERENCES `niches`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `voice_personas_by_niche` ON `voice_personas` (`niche_id`);--> statement-breakpoint
ALTER TABLE `generations` ADD `transcript` text;