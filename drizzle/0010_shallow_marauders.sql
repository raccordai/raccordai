CREATE TABLE `generation_annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`generation_id` text NOT NULL,
	`video_id` text NOT NULL,
	`region` text,
	`timecode_sec` real,
	`comment` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`generation_id`) REFERENCES `generations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `annotations_by_generation` ON `generation_annotations` (`generation_id`);--> statement-breakpoint
CREATE TABLE `video_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` text NOT NULL,
	`name` text NOT NULL,
	`workflow` text NOT NULL,
	`snapshot` text NOT NULL,
	`selections` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `checkpoints_by_video` ON `video_checkpoints` (`video_id`);