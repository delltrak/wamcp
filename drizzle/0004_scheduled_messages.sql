-- Millisecond timestamps and seq are bigint. SQLite stores that as a 64-bit
-- integer. The same column types fit Postgres int8, so this script is safe to
-- absorb without narrowing those values to 32-bit integer.
CREATE TABLE `scheduled_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`recipient` text NOT NULL,
	`message_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`timezone` text NOT NULL,
	`recurrence` text NOT NULL,
	`scheduled_at` bigint NOT NULL,
	`next_run_at` bigint NOT NULL,
	`weekdays_json` text,
	`day_of_month` integer,
	`end_at` bigint,
	`occurrence_limit` integer,
	`occurrence_count` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`lease_token` text,
	`lease_until` bigint,
	`last_run_at` bigint,
	`last_job_id` text,
	`last_error` text,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	`seq` bigint DEFAULT 0 NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_messages_due` ON `scheduled_messages` (`status`,`next_run_at`,`created_at`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_messages_instance` ON `scheduled_messages` (`instance_id`,`status`);
