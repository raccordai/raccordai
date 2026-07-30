CREATE TABLE `text_layers` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` text NOT NULL,
	`content` text NOT NULL,
	`start_sec` real NOT NULL,
	`end_sec` real NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`anchor` integer NOT NULL,
	`font_family` text,
	`size_pct` real NOT NULL,
	`bold` integer NOT NULL,
	`italic` integer NOT NULL,
	`color_hex` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `text_layers_by_video` ON `text_layers` (`video_id`);