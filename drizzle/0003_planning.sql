CREATE TABLE `planning_monthly_target` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`month` text NOT NULL,
	`expense_target_amount` integer NOT NULL,
	`income_target_amount` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_monthly_target_user_month_unique` ON `planning_monthly_target` (`user_id`,`month`);--> statement-breakpoint
CREATE TABLE `planning_recurring_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`amount` integer NOT NULL,
	`category_id` text NOT NULL,
	`payment_method` text NOT NULL,
	`account_id` text,
	`payment_day` integer NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `ledger_category`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `planning_recurring_rule_user_active_idx` ON `planning_recurring_rule` (`user_id`,`active`);--> statement-breakpoint
CREATE TABLE `planning_recurring_run` (
	`rule_id` text NOT NULL,
	`month` text NOT NULL,
	`transaction_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `planning_recurring_rule`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`transaction_id`) REFERENCES `ledger_transaction`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_recurring_run_rule_month_unique` ON `planning_recurring_run` (`rule_id`,`month`);--> statement-breakpoint
CREATE INDEX `planning_recurring_run_transaction_idx` ON `planning_recurring_run` (`transaction_id`);
