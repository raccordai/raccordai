ALTER TABLE `assets` ADD `uploaded_url` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `uploaded_at` integer;--> statement-breakpoint
ALTER TABLE `generations` ADD `result_uploaded_url` text;--> statement-breakpoint
ALTER TABLE `generations` ADD `result_uploaded_at` integer;--> statement-breakpoint
ALTER TABLE `generations` ADD `last_frame_uploaded_url` text;--> statement-breakpoint
ALTER TABLE `generations` ADD `last_frame_uploaded_at` integer;