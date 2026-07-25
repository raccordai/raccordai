ALTER TABLE `generations` ADD `draft` integer;--> statement-breakpoint
ALTER TABLE `generations` ADD `qc_verdict` text;--> statement-breakpoint
ALTER TABLE `generations` ADD `qc_notes` text;--> statement-breakpoint
ALTER TABLE `videos` ADD `draft_mode` integer;--> statement-breakpoint
ALTER TABLE `videos` ADD `qc_enabled` integer;