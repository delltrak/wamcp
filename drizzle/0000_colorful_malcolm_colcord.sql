CREATE TABLE `auth_keys` (
	`instance_id` text NOT NULL,
	`key_id` text NOT NULL,
	`key_data` text NOT NULL,
	PRIMARY KEY(`instance_id`, `key_id`),
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_auth_keys_instance` ON `auth_keys` (`instance_id`);--> statement-breakpoint
CREATE TABLE `chats` (
	`instance_id` text NOT NULL,
	`jid` text NOT NULL,
	`name` text,
	`is_group` integer DEFAULT 0 NOT NULL,
	`unread_count` integer DEFAULT 0 NOT NULL,
	`is_pinned` integer DEFAULT 0 NOT NULL,
	`is_muted` integer DEFAULT 0 NOT NULL,
	`mute_until` integer,
	`is_archived` integer DEFAULT 0 NOT NULL,
	`last_message_id` text,
	`last_message_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`instance_id`, `jid`),
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chats_recent` ON `chats` (`instance_id`,`last_message_at`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`instance_id` text NOT NULL,
	`jid` text NOT NULL,
	`name` text,
	`notify_name` text,
	`phone` text,
	`profile_pic_url` text,
	`is_business` integer DEFAULT 0 NOT NULL,
	`is_blocked` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`instance_id`, `jid`),
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_contacts_phone` ON `contacts` (`instance_id`,`phone`);--> statement-breakpoint
CREATE TABLE `groups_cache` (
	`instance_id` text NOT NULL,
	`jid` text NOT NULL,
	`subject` text,
	`description` text,
	`owner_jid` text,
	`participants` text DEFAULT '[]' NOT NULL,
	`participant_count` integer DEFAULT 0 NOT NULL,
	`is_announce` integer DEFAULT 0 NOT NULL,
	`is_locked` integer DEFAULT 0 NOT NULL,
	`ephemeral_duration` integer,
	`invite_code` text,
	`created_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`instance_id`, `jid`),
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `instances` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`channel` text DEFAULT 'baileys' NOT NULL,
	`phone_number` text,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`wa_version` text,
	`cloud_access_token` text,
	`cloud_phone_number_id` text,
	`cloud_business_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_connected` integer,
	`last_disconnected` integer
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text NOT NULL,
	`instance_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`type` text NOT NULL,
	`content` text,
	`media_url` text,
	`media_local` text,
	`media_mimetype` text,
	`quoted_id` text,
	`is_from_me` integer DEFAULT 0 NOT NULL,
	`is_forwarded` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`timestamp` integer NOT NULL,
	`raw_data` text,
	PRIMARY KEY(`instance_id`, `id`),
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_messages_chat` ON `messages` (`instance_id`,`chat_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_messages_timestamp` ON `messages` (`instance_id`,`timestamp`);--> statement-breakpoint
CREATE TABLE `processed_messages` (
	`message_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`processed_at` integer NOT NULL,
	PRIMARY KEY(`instance_id`, `message_id`),
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `queue_stats` (
	`instance_id` text PRIMARY KEY NOT NULL,
	`messages_sent` integer DEFAULT 0 NOT NULL,
	`messages_failed` integer DEFAULT 0 NOT NULL,
	`last_sent_at` integer,
	`rate_limited_until` integer,
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `wa_version_cache` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`version_json` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`is_latest` integer DEFAULT 1 NOT NULL
);
