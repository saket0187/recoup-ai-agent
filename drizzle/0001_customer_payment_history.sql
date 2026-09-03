ALTER TABLE `customers` ADD `prior_bills_settled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `customers` ADD `prior_bills_paid` integer DEFAULT 0 NOT NULL;