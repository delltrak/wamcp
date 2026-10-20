CREATE TABLE `instance_webhooks` (
	`instance_id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`auth_header` text,
	`auth_value` text,
	`events` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE cascade
);
