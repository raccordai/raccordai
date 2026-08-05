CREATE TABLE `niche_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`niche_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`handle` text,
	`url` text NOT NULL,
	`thumbnail` text,
	`subscribers` integer NOT NULL,
	`video_count` integer NOT NULL,
	`view_count` integer NOT NULL,
	`channel_created_at` text,
	`uploads_playlist_id` text,
	`is_mine` integer NOT NULL,
	`notes` text,
	`last_refreshed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`niche_id`) REFERENCES `niches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `niche_channels_by_niche` ON `niche_channels` (`niche_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `niche_channels_unique` ON `niche_channels` (`niche_id`,`channel_id`);--> statement-breakpoint
CREATE TABLE `niche_videos` (
	`id` text PRIMARY KEY NOT NULL,
	`niche_id` text NOT NULL,
	`video_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`channel_title` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`url` text NOT NULL,
	`thumbnail` text,
	`published_at` text,
	`views` integer NOT NULL,
	`duration_seconds` integer NOT NULL,
	`made_for_kids` integer NOT NULL,
	`channel_subscribers` integer NOT NULL,
	`channel_created_at` text,
	`source` text NOT NULL,
	`keyword` text,
	`transcript` text,
	`transcript_fetched_at` integer,
	`stats_refreshed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`niche_id`) REFERENCES `niches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `niche_videos_by_niche` ON `niche_videos` (`niche_id`);--> statement-breakpoint
CREATE INDEX `niche_videos_by_channel` ON `niche_videos` (`niche_id`,`channel_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `niche_videos_unique` ON `niche_videos` (`niche_id`,`video_id`);--> statement-breakpoint
CREATE TABLE `niches` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`language_code` text NOT NULL,
	`location_code` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
