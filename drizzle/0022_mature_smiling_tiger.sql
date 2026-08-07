CREATE TABLE `image_layers` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` text NOT NULL,
	`node_id` text,
	`asset_id` text,
	`start_sec` real NOT NULL,
	`end_sec` real NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`width_pct` real NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `image_layers_by_video` ON `image_layers` (`video_id`);--> statement-breakpoint
ALTER TABLE `nodes` ADD `timeline_offset_sec` real;