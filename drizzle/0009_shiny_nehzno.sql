CREATE TABLE `chat_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`project_id` text NOT NULL,
	`video_id` text,
	`history` text NOT NULL,
	`items` text NOT NULL,
	`watched` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
