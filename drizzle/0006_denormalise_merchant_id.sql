ALTER TABLE `actions` ADD `merchant_id` text REFERENCES merchants(id);--> statement-breakpoint
UPDATE `actions` SET `merchant_id` = (SELECT `merchant_id` FROM `risk_cases` WHERE `risk_cases`.`id` = `actions`.`case_id`) WHERE `merchant_id` IS NULL;--> statement-breakpoint
CREATE INDEX `actions_merchant_status_idx` ON `actions` (`merchant_id`,`status`);--> statement-breakpoint
ALTER TABLE `contact_events` ADD `merchant_id` text REFERENCES merchants(id);--> statement-breakpoint
UPDATE `contact_events` SET `merchant_id` = (SELECT `merchant_id` FROM `risk_cases` WHERE `risk_cases`.`id` = `contact_events`.`case_id`) WHERE `merchant_id` IS NULL;--> statement-breakpoint
CREATE INDEX `contact_merchant_sent_idx` ON `contact_events` (`merchant_id`,`sent_at`);--> statement-breakpoint
ALTER TABLE `decisions` ADD `merchant_id` text REFERENCES merchants(id);--> statement-breakpoint
UPDATE `decisions` SET `merchant_id` = (SELECT `merchant_id` FROM `risk_cases` WHERE `risk_cases`.`id` = `decisions`.`case_id`) WHERE `merchant_id` IS NULL;--> statement-breakpoint
CREATE INDEX `decisions_merchant_at_idx` ON `decisions` (`merchant_id`,`at`);
