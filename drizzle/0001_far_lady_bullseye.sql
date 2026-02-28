ALTER TABLE `contacts` ADD `lid` text;--> statement-breakpoint
CREATE INDEX `idx_contacts_lid` ON `contacts` (`instance_id`,`lid`);