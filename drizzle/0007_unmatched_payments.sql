CREATE TABLE `unmatched_payments` (
	`provider_ref` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`reference` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "unmatched_payments_amount_ck" CHECK("unmatched_payments"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE INDEX `unmatched_payments_reference_idx` ON `unmatched_payments` (`merchant_id`,`reference`);--> statement-breakpoint
CREATE INDEX `unmatched_payments_at_idx` ON `unmatched_payments` (`merchant_id`,`at`);