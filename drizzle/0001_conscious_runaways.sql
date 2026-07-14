CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`kind` text NOT NULL,
	`file_path` text,
	`source_url` text,
	`mime_type` text,
	`size` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `assets_by_project` ON `assets` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `assets_by_project_key` ON `assets` (`project_id`,`key`);--> statement-breakpoint
CREATE TABLE `edges` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` text NOT NULL,
	`source_node_id` text NOT NULL,
	`source_handle` text NOT NULL,
	`target_node_id` text NOT NULL,
	`target_handle` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `edges_by_video` ON `edges` (`video_id`);--> statement-breakpoint
CREATE TABLE `generations` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`video_id` text NOT NULL,
	`status` text NOT NULL,
	`kie_task_id` text,
	`input_snapshot` text,
	`result_url` text,
	`result_path` text,
	`result_mime_type` text,
	`last_frame_path` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `generations_by_node` ON `generations` (`node_id`);--> statement-breakpoint
CREATE INDEX `generations_by_video` ON `generations` (`video_id`);--> statement-breakpoint
CREATE INDEX `generations_by_kie_task` ON `generations` (`kie_task_id`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` text NOT NULL,
	`key` text NOT NULL,
	`model_id` text NOT NULL,
	`label` text,
	`intent` text,
	`position_x` real NOT NULL,
	`position_y` real NOT NULL,
	`params` text NOT NULL,
	`selected_generation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `nodes_by_video` ON `nodes` (`video_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_by_video_key` ON `nodes` (`video_id`,`key`);--> statement-breakpoint
CREATE TABLE `videos` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `videos_by_project` ON `videos` (`project_id`);