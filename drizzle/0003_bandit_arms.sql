CREATE TABLE `bandit_arms` (
	`merchant_id` text NOT NULL,
	`arm_key` text NOT NULL,
	`successes` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`merchant_id`, `arm_key`),
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bandit_arms_successes_ck" CHECK("bandit_arms"."successes" >= 0),
	CONSTRAINT "bandit_arms_failures_ck" CHECK("bandit_arms"."failures" >= 0)
);
