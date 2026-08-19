CREATE TABLE `feedback_items` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` text NOT NULL,
	`node_id` text,
	`node_label` text,
	`timecode_sec` real,
	`comment` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feedback_items_by_video` ON `feedback_items` (`video_id`);