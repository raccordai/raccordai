CREATE TABLE `chat_sessions` (
	`video_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`history` text NOT NULL,
	`items` text NOT NULL,
	`watched` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `assets` ADD `tags` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `content_hash` text;--> statement-breakpoint
CREATE INDEX `assets_by_project_hash` ON `assets` (`project_id`,`content_hash`);--> statement-breakpoint
ALTER TABLE `generations` ADD `credits_estimated` real;