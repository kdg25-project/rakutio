ALTER TABLE `ledger_transaction` ADD COLUMN `account_id` text;
--> statement-breakpoint
ALTER TABLE `ledger_transaction` ADD COLUMN `gift_account_id` text;
--> statement-breakpoint
CREATE TABLE `asset_account` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL CHECK(`type` IN ('bank', 'cash', 'gift')),
	`name` text NOT NULL,
	`balance_amount` integer DEFAULT 0 NOT NULL,
	`is_archived` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `asset_account_user_active_idx` ON `asset_account` (`user_id`,`is_archived`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `asset_account_user_name_unique` ON `asset_account` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `asset_operation` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text,
	`key` text NOT NULL,
	`kind` text NOT NULL CHECK(`kind` IN ('opening', 'adjustment', 'transfer')),
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `asset_account`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_operation_user_key_unique` ON `asset_operation` (`user_id`,`key`);--> statement-breakpoint
CREATE TABLE `asset_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`operation_id` text,
	`transaction_id` text,
	`kind` text NOT NULL CHECK(`kind` IN ('opening', 'adjustment', 'transfer', 'transaction')),
	`amount` integer NOT NULL,
	`occurred_at` text NOT NULL,
	`memo` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `asset_account`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`operation_id`) REFERENCES `asset_operation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `ledger_transaction`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `asset_entry_account_date_idx` ON `asset_entry` (`account_id`,`occurred_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `asset_entry_user_created_idx` ON `asset_entry` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `asset_entry_transaction_account_unique` ON `asset_entry` (`transaction_id`,`account_id`);--> statement-breakpoint
CREATE TRIGGER `asset_entry_insert_guard`
BEFORE INSERT ON `asset_entry`
BEGIN
	SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM `asset_account` WHERE `id` = NEW.`account_id` AND `user_id` = NEW.`user_id` AND `is_archived` = 0) THEN RAISE(ABORT, 'asset account unavailable') END);
	SELECT (CASE WHEN NEW.`operation_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `asset_operation` WHERE `id` = NEW.`operation_id` AND `user_id` = NEW.`user_id`) THEN RAISE(ABORT, 'asset operation owner mismatch') END);
	SELECT (CASE WHEN NEW.`transaction_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `ledger_transaction` WHERE `id` = NEW.`transaction_id` AND `user_id` = NEW.`user_id`) THEN RAISE(ABORT, 'asset transaction owner mismatch') END);
	SELECT (CASE WHEN (SELECT `type` FROM `asset_account` WHERE `id` = NEW.`account_id`) = 'gift' AND (SELECT `balance_amount` FROM `asset_account` WHERE `id` = NEW.`account_id`) + NEW.`amount` < 0 THEN RAISE(ABORT, 'gift balance insufficient') END);
END;
--> statement-breakpoint
CREATE TRIGGER `asset_entry_balance_apply`
AFTER INSERT ON `asset_entry`
BEGIN
	UPDATE `asset_account` SET `balance_amount` = `balance_amount` + NEW.`amount`, `updated_at` = NEW.`created_at` WHERE `id` = NEW.`account_id` AND `user_id` = NEW.`user_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `asset_entry_balance_reverse`
AFTER DELETE ON `asset_entry`
BEGIN
	UPDATE `asset_account` SET `balance_amount` = `balance_amount` - OLD.`amount`, `updated_at` = OLD.`created_at` WHERE `id` = OLD.`account_id` AND `user_id` = OLD.`user_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `asset_entry_immutable`
BEFORE UPDATE ON `asset_entry`
BEGIN
	SELECT RAISE(ABORT, 'asset entries are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `ledger_transaction_asset_insert_guard`
BEFORE INSERT ON `ledger_transaction`
BEGIN
	SELECT (CASE WHEN NEW.`account_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `asset_account` WHERE `id` = NEW.`account_id` AND `user_id` = NEW.`user_id` AND `is_archived` = 0 AND `type` IN ('bank', 'cash')) THEN RAISE(ABORT, 'cash account unavailable') END);
	SELECT (CASE WHEN NEW.`gift_certificate_used_amount` > 0 AND (NEW.`gift_account_id` IS NULL OR NOT EXISTS (SELECT 1 FROM `asset_account` WHERE `id` = NEW.`gift_account_id` AND `user_id` = NEW.`user_id` AND `is_archived` = 0 AND `type` = 'gift')) THEN RAISE(ABORT, 'gift account unavailable') END);
	SELECT (CASE WHEN NEW.`gift_certificate_used_amount` = 0 AND NEW.`gift_account_id` IS NOT NULL THEN RAISE(ABORT, 'gift account without gift use') END);
END;
--> statement-breakpoint
CREATE TRIGGER `ledger_transaction_asset_update_guard`
BEFORE UPDATE OF `account_id`, `gift_account_id`, `gift_certificate_used_amount` ON `ledger_transaction`
BEGIN
	SELECT (CASE WHEN NEW.`account_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `asset_account` WHERE `id` = NEW.`account_id` AND `user_id` = NEW.`user_id` AND `is_archived` = 0 AND `type` IN ('bank', 'cash')) THEN RAISE(ABORT, 'cash account unavailable') END);
	SELECT (CASE WHEN NEW.`gift_certificate_used_amount` > 0 AND (NEW.`gift_account_id` IS NULL OR NOT EXISTS (SELECT 1 FROM `asset_account` WHERE `id` = NEW.`gift_account_id` AND `user_id` = NEW.`user_id` AND `is_archived` = 0 AND `type` = 'gift')) THEN RAISE(ABORT, 'gift account unavailable') END);
	SELECT (CASE WHEN NEW.`gift_certificate_used_amount` = 0 AND NEW.`gift_account_id` IS NOT NULL THEN RAISE(ABORT, 'gift account without gift use') END);
END;
