CREATE TABLE `niche_roadmap_items` (
	`id` text PRIMARY KEY NOT NULL,
	`niche_id` text NOT NULL,
	`title` text NOT NULL,
	`angle` text,
	`description` text,
	`thumbnail_brief` text,
	`evidence` text,
	`video_type` text NOT NULL,
	`status` text NOT NULL,
	`video_id` text,
	`published_video_id` text,
	`sort_order` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`niche_id`) REFERENCES `niches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `roadmap_by_niche` ON `niche_roadmap_items` (`niche_id`);--> statement-breakpoint
ALTER TABLE `niches` ADD `style_id` text;--> statement-breakpoint
ALTER TABLE `niches` ADD `aspect_ratio` text;--> statement-breakpoint
ALTER TABLE `niches` ADD `target_seconds` integer;