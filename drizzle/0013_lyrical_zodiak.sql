ALTER TABLE `nodes` ADD `timeline_order` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `trim_start_sec` real;--> statement-breakpoint
ALTER TABLE `nodes` ADD `trim_end_sec` real;--> statement-breakpoint
ALTER TABLE `nodes` ADD `transition_after` text;