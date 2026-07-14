CREATE TABLE `chat_home_session` (
	`id` text PRIMARY KEY NOT NULL,
	`history` text NOT NULL,
	`items` text NOT NULL,
	`watched` text NOT NULL,
	`updated_at` integer NOT NULL
);
