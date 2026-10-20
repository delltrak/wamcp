CREATE TABLE `scheduled_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`recipient` text NOT NULL,
	`message_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`timezone` text NOT NULL,
	`recurrence` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`next_run_at` integer NOT NULL,
	`weekdays_json` text,
	`day_of_month` integer,
	`end_at` integer,
	`occurrence_limit` integer,
	`occurrence_count` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`lease_token` text,
	`lease_until` integer,
	`last_run_at` integer,
	`last_job_id` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_messages_due` ON `scheduled_messages` (`status`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_messages_instance` ON `scheduled_messages` (`instance_id`,`status`);