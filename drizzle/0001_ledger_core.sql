CREATE TABLE `receipt` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`object_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`analysis_status` text DEFAULT 'pending' NOT NULL CHECK(`analysis_status` IN ('pending', 'analyzed', 'failed', 'deleting')),
	`analysis_json` text,
	`created_at` integer NOT NULL,
	`analyzed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_object_key_unique` ON `receipt` (`object_key`);--> statement-breakpoint
CREATE INDEX `receipt_user_created_idx` ON `receipt` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ledger_category` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`icon` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_category_user_name_unique` ON `ledger_category` (`user_id`,`name`);--> statement-breakpoint
CREATE INDEX `ledger_category_user_created_idx` ON `ledger_category` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ledger_transaction` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`receipt_id` text,
	`type` text NOT NULL CHECK(`type` IN ('expense', 'income')),
	`occurred_at` text NOT NULL,
	`title` text NOT NULL,
	`merchant` text DEFAULT '' NOT NULL,
	`merchant_normalized` text DEFAULT '' NOT NULL,
	`memo` text DEFAULT '' NOT NULL,
	`payment_method` text DEFAULT 'cash' NOT NULL,
	`gross_amount` integer NOT NULL,
	`item_discount_amount` integer NOT NULL,
	`receipt_discount_amount` integer NOT NULL,
	`discount_amount` integer NOT NULL,
	`net_amount` integer NOT NULL,
	`point_used_amount` integer NOT NULL,
	`gift_certificate_used_amount` integer NOT NULL,
	`non_cash_amount` integer NOT NULL,
	`cash_paid_amount` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipt`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ledger_transaction_user_date_idx` ON `ledger_transaction` (`user_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `ledger_transaction_duplicate_idx` ON `ledger_transaction` (`user_id`,`occurred_at`,`merchant_normalized`,`net_amount`);--> statement-breakpoint
CREATE INDEX `ledger_transaction_receipt_idx` ON `ledger_transaction` (`user_id`,`receipt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_transaction_receipt_unique` ON `ledger_transaction` (`receipt_id`);--> statement-breakpoint
CREATE TRIGGER `ledger_transaction_receipt_insert_guard`
BEFORE INSERT ON `ledger_transaction`
WHEN NEW.`receipt_id` IS NOT NULL
BEGIN
	SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM `receipt` WHERE `id` = NEW.`receipt_id` AND `user_id` = NEW.`user_id`) THEN RAISE(ABORT, 'receipt owner mismatch') END;
	SELECT CASE WHEN EXISTS (SELECT 1 FROM `receipt` WHERE `id` = NEW.`receipt_id` AND `analysis_status` = 'deleting') THEN RAISE(ABORT, 'receipt is deleting') END;
END;
--> statement-breakpoint
CREATE TRIGGER `ledger_transaction_receipt_update_guard`
BEFORE UPDATE OF `receipt_id` ON `ledger_transaction`
WHEN NEW.`receipt_id` IS NOT NULL
BEGIN
	SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM `receipt` WHERE `id` = NEW.`receipt_id` AND `user_id` = NEW.`user_id`) THEN RAISE(ABORT, 'receipt owner mismatch') END;
	SELECT CASE WHEN EXISTS (SELECT 1 FROM `receipt` WHERE `id` = NEW.`receipt_id` AND `analysis_status` = 'deleting') THEN RAISE(ABORT, 'receipt is deleting') END;
END;
--> statement-breakpoint
CREATE TABLE `ledger_transaction_item` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`category_id` text NOT NULL,
	`name` text NOT NULL,
	`original_amount` integer NOT NULL,
	`item_discount_amount` integer NOT NULL,
	`allocated_receipt_discount_amount` integer NOT NULL,
	`final_amount` integer NOT NULL,
	`allocated_point_amount` integer NOT NULL,
	`allocated_gift_certificate_amount` integer NOT NULL,
	`paid_amount` integer NOT NULL,
	`sort_order` integer NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `ledger_transaction`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `ledger_category`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `ledger_transaction_item_transaction_idx` ON `ledger_transaction_item` (`transaction_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `ledger_transaction_item_category_idx` ON `ledger_transaction_item` (`category_id`);--> statement-breakpoint
CREATE TABLE `ledger_idempotency` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`transaction_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `ledger_transaction`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_idempotency_user_key_unique` ON `ledger_idempotency` (`user_id`,`key`);
