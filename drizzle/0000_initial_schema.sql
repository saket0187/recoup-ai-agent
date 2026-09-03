CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`decision_id` text NOT NULL,
	`case_id` text NOT NULL,
	`type` text NOT NULL,
	`channel` text,
	`template_id` text,
	`language` text,
	`amount_paise` integer,
	`scheduled_for` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'SCHEDULED' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`provider_ref` text,
	`cost_paise` integer DEFAULT 0 NOT NULL,
	`dry_run` integer NOT NULL,
	`last_error` text,
	`executed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`case_id`) REFERENCES `risk_cases`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "actions_attempts_ck" CHECK("actions"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actions_idempotency_uq` ON `actions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `actions_due_idx` ON `actions` (`status`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `actions_case_idx` ON `actions` (`case_id`);--> statement-breakpoint
CREATE TABLE `audit_records` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`seq` integer NOT NULL,
	`at` integer NOT NULL,
	`entry_type` text NOT NULL,
	`case_id` text,
	`subject_id` text,
	`actor` text NOT NULL,
	`payload` text NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "audit_seq_ck" CHECK("audit_records"."seq" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_merchant_seq_uq` ON `audit_records` (`merchant_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `audit_hash_uq` ON `audit_records` (`hash`);--> statement-breakpoint
CREATE INDEX `audit_case_idx` ON `audit_records` (`case_id`);--> statement-breakpoint
CREATE INDEX `audit_at_idx` ON `audit_records` (`at`);--> statement-breakpoint
CREATE TABLE `cohorts` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`key` text NOT NULL,
	`method` text NOT NULL,
	`issuer` text,
	`window_start` integer NOT NULL,
	`window_end` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`successes` integer DEFAULT 0 NOT NULL,
	`wilson_lcb` real DEFAULT 0 NOT NULL,
	`baseline_ewma` real DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'HEALTHY' NOT NULL,
	`since` integer NOT NULL,
	`paused_until` integer,
	`canary_pct` real,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cohorts_successes_ck" CHECK("cohorts"."successes" >= 0 and "cohorts"."successes" <= "cohorts"."attempts")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cohorts_merchant_key_window_uq` ON `cohorts` (`merchant_id`,`key`,`window_start`);--> statement-breakpoint
CREATE INDEX `cohorts_state_idx` ON `cohorts` (`state`);--> statement-breakpoint
CREATE TABLE `consent_records` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`channel` text NOT NULL,
	`granted` integer NOT NULL,
	`dnd` integer DEFAULT false NOT NULL,
	`purpose` text NOT NULL,
	`source` text NOT NULL,
	`captured_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `consent_customer_channel_idx` ON `consent_records` (`customer_id`,`channel`);--> statement-breakpoint
CREATE INDEX `consent_captured_idx` ON `consent_records` (`captured_at`);--> statement-breakpoint
CREATE TABLE `contact_events` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`action_id` text,
	`channel` text NOT NULL,
	`direction` text NOT NULL,
	`template_id` text,
	`language` text NOT NULL,
	`body_hash` text NOT NULL,
	`body` text,
	`sent_at` integer NOT NULL,
	`delivered` integer DEFAULT false NOT NULL,
	`replied` integer DEFAULT false NOT NULL,
	`intent` text,
	`opt_out` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `risk_cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`action_id`) REFERENCES `actions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contact_case_sent_idx` ON `contact_events` (`case_id`,`sent_at`);--> statement-breakpoint
CREATE INDEX `contact_customer_sent_idx` ON `contact_events` (`customer_id`,`sent_at`);--> statement-breakpoint
CREATE INDEX `contact_channel_sent_idx` ON `contact_events` (`channel`,`sent_at`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`external_ref` text NOT NULL,
	`portfolio` text NOT NULL,
	`language_pref` text DEFAULT 'en' NOT NULL,
	`timezone` text DEFAULT 'Asia/Kolkata' NOT NULL,
	`opted_out_global` integer DEFAULT false NOT NULL,
	`dnd` integer DEFAULT false NOT NULL,
	`risk_flagged` integer DEFAULT false NOT NULL,
	`deceased` integer DEFAULT false NOT NULL,
	`contact_data_suspect` integer DEFAULT false NOT NULL,
	`trust_score` integer DEFAULT 50 NOT NULL,
	`mandate_cap_paise` integer,
	`erasure_requested_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "customers_trust_score_ck" CHECK("customers"."trust_score" between 0 and 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_merchant_ref_uq` ON `customers` (`merchant_id`,`external_ref`);--> statement-breakpoint
CREATE INDEX `customers_merchant_idx` ON `customers` (`merchant_id`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`at` integer NOT NULL,
	`clock_mode` text NOT NULL,
	`feature_snapshot` text NOT NULL,
	`candidates` text NOT NULL,
	`chosen_action` text NOT NULL,
	`chosen_channel` text,
	`chosen_by` text NOT NULL,
	`propensity` real NOT NULL,
	`retrieved_case_ids` text NOT NULL,
	`policy_evaluations` text NOT NULL,
	`stop_evaluations` text NOT NULL,
	`reviewer_verdict` text,
	`reviewer_reason` text,
	`final_verdict` text NOT NULL,
	`defer_until` integer,
	`suppress_reason` text,
	`policy_version` text NOT NULL,
	`playbook_version` text NOT NULL,
	`model_version` text,
	`prompt_hash` text,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `risk_cases`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "decisions_propensity_ck" CHECK("decisions"."propensity" > 0 and "decisions"."propensity" <= 1)
);
--> statement-breakpoint
CREATE INDEX `decisions_case_at_idx` ON `decisions` (`case_id`,`at`);--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_hash_uq` ON `decisions` (`hash`);--> statement-breakpoint
CREATE TABLE `diagnoses` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`failure_class` text NOT NULL,
	`confidence` real NOT NULL,
	`evidence` text NOT NULL,
	`signature` text,
	`attributed_to` text,
	`cohort_id` text,
	`method` text NOT NULL,
	`model_used` integer DEFAULT false NOT NULL,
	`model_version` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `risk_cases`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "diagnoses_confidence_ck" CHECK("diagnoses"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE INDEX `diagnoses_case_idx` ON `diagnoses` (`case_id`);--> statement-breakpoint
CREATE INDEX `diagnoses_class_idx` ON `diagnoses` (`failure_class`);--> statement-breakpoint
CREATE TABLE `ledger_events` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`merchant_id` text NOT NULL,
	`type` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`at` integer NOT NULL,
	`ref` text,
	`provider_ref` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `risk_cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ledger_amount_nonzero_ck" CHECK("ledger_events"."amount_paise" <> 0),
	CONSTRAINT "ledger_sign_ck" CHECK(("ledger_events"."type" in ('CHARGE', 'REFUND') and "ledger_events"."amount_paise" > 0)
          or ("ledger_events"."type" in ('PAYMENT', 'CREDIT_NOTE', 'TDS_ADJUSTMENT', 'WRITE_OFF') and "ledger_events"."amount_paise" < 0))
);
--> statement-breakpoint
CREATE INDEX `ledger_case_at_idx` ON `ledger_events` (`case_id`,`at`);--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_provider_ref_uq` ON `ledger_events` (`provider_ref`);--> statement-breakpoint
CREATE TABLE `merchants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`timezone` text DEFAULT 'Asia/Kolkata' NOT NULL,
	`margin_rate_bp` integer DEFAULT 3000 NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `promises` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`promised_date` integer NOT NULL,
	`source` text NOT NULL,
	`confidence` real NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`superseded_by` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`case_id`) REFERENCES `risk_cases`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "promises_confidence_ck" CHECK("promises"."confidence" between 0 and 1),
	CONSTRAINT "promises_amount_ck" CHECK("promises"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE INDEX `promises_case_status_idx` ON `promises` (`case_id`,`status`);--> statement-breakpoint
CREATE INDEX `promises_due_idx` ON `promises` (`promised_date`);--> statement-breakpoint
CREATE TABLE `provider_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`entity_id` text,
	`payload_hash` text NOT NULL,
	`raw_body` text NOT NULL,
	`provider_created_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	`processing_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_events_uq` ON `provider_events` (`provider`,`event_id`);--> statement-breakpoint
CREATE INDEX `provider_events_unprocessed_idx` ON `provider_events` (`processed_at`);--> statement-breakpoint
CREATE INDEX `provider_events_entity_idx` ON `provider_events` (`entity_id`);--> statement-breakpoint
CREATE TABLE `risk_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`type` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`due_at` integer NOT NULL,
	`source_entity` text NOT NULL,
	`state` text DEFAULT 'OPEN' NOT NULL,
	`stop_reason` text,
	`arm` text NOT NULL,
	`stratum` text NOT NULL,
	`cohort_id` text,
	`dispute_opened_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`touch_count` integer DEFAULT 0 NOT NULL,
	`recovered_paise` integer DEFAULT 0 NOT NULL,
	`cost_paise` integer DEFAULT 0 NOT NULL,
	`policy_version` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`next_decision_at` integer,
	`resolved_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "risk_cases_amount_ck" CHECK("risk_cases"."amount_paise" > 0),
	CONSTRAINT "risk_cases_counts_ck" CHECK("risk_cases"."attempt_count" >= 0 and "risk_cases"."touch_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `risk_cases_state_idx` ON `risk_cases` (`state`);--> statement-breakpoint
CREATE INDEX `risk_cases_customer_idx` ON `risk_cases` (`customer_id`);--> statement-breakpoint
CREATE INDEX `risk_cases_merchant_state_idx` ON `risk_cases` (`merchant_id`,`state`);--> statement-breakpoint
CREATE INDEX `risk_cases_resolved_idx` ON `risk_cases` (`resolved_at`);--> statement-breakpoint
CREATE INDEX `risk_cases_due_idx` ON `risk_cases` (`state`,`next_decision_at`);--> statement-breakpoint
CREATE INDEX `risk_cases_arm_idx` ON `risk_cases` (`arm`);