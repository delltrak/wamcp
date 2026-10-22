CREATE TABLE `auto_reply_cooldowns` (
	`instance_id` text NOT NULL,
	`contact_key` text NOT NULL,
	`last_reply_at` integer NOT NULL,
	PRIMARY KEY(`instance_id`, `contact_key`),
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE cascade
);
