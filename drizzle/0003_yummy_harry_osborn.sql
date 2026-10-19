CREATE TABLE `group_member_labels` (
	`instance_id` text NOT NULL,
	`group_jid` text NOT NULL,
	`participant_jid` text NOT NULL,
	`member_label` text,
	`label_timestamp` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`instance_id`, `group_jid`, `participant_jid`),
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE cascade
);
