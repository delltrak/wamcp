CREATE TABLE `group_history_sends` (
	`instance_id` text NOT NULL,
	`message_id` text NOT NULL,
	`sent_at` integer NOT NULL,
	PRIMARY KEY(`instance_id`, `message_id`),
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE cascade
);
