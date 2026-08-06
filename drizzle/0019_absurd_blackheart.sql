CREATE TABLE `niche_video_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`niche_video_id` text NOT NULL,
	`views` integer NOT NULL,
	`like_count` integer,
	`channel_subscribers` integer NOT NULL,
	`captured_at` integer NOT NULL,
	FOREIGN KEY (`niche_video_id`) REFERENCES `niche_videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `niche_video_snapshots_by_video` ON `niche_video_snapshots` (`niche_video_id`,`captured_at`);--> statement-breakpoint
ALTER TABLE `niche_roadmap_items` ADD `title_variants` text;--> statement-breakpoint
ALTER TABLE `niche_videos` ADD `like_count` integer;--> statement-breakpoint
ALTER TABLE `niche_videos` ADD `comment_count` integer;--> statement-breakpoint
ALTER TABLE `niche_videos` ADD `tags` text;--> statement-breakpoint
ALTER TABLE `niche_videos` ADD `category_id` text;--> statement-breakpoint
ALTER TABLE `niche_videos` ADD `language` text;--> statement-breakpoint
ALTER TABLE `niche_videos` ADD `has_captions` integer;--> statement-breakpoint
ALTER TABLE `niche_videos` ADD `serp_rank` integer;--> statement-breakpoint
ALTER TABLE `niche_videos` ADD `transcript_language` text;--> statement-breakpoint
ALTER TABLE `niche_videos` ADD `transcript_is_asr` integer;--> statement-breakpoint
ALTER TABLE `videos` ADD `roadmap_item_id` text;