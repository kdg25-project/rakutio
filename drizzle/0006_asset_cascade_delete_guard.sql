CREATE TABLE `asset_user_deletion_guard` (`user_id` text PRIMARY KEY NOT NULL);
--> statement-breakpoint
CREATE TRIGGER `asset_user_delete_guard_begin`
BEFORE DELETE ON `user`
BEGIN
	INSERT OR IGNORE INTO `asset_user_deletion_guard` (`user_id`) VALUES (OLD.`id`);
END;
--> statement-breakpoint
CREATE TRIGGER `asset_user_delete_guard_end`
AFTER DELETE ON `user`
BEGIN
	DELETE FROM `asset_user_deletion_guard` WHERE `user_id` = OLD.`id`;
END;
--> statement-breakpoint
DROP TRIGGER `asset_entry_bounds_delete_guard`;
--> statement-breakpoint
CREATE TRIGGER `asset_entry_bounds_delete_guard`
BEFORE DELETE ON `asset_entry`
BEGIN
	-- User deletion cascades remove the parent first. Skip balance repair checks then,
	-- because its accounts and entries are being removed as one foreign-key action.
	SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM `asset_user_deletion_guard` WHERE `user_id` = OLD.`user_id`) AND (typeof(OLD.`amount`) <> 'integer' OR OLD.`amount` < -1000000000000 OR OLD.`amount` > 1000000000000) THEN RAISE(ABORT, 'asset entry amount out of range') END);
	SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM `asset_user_deletion_guard` WHERE `user_id` = OLD.`user_id`) AND EXISTS (SELECT 1 FROM `asset_account` WHERE `id` = OLD.`account_id` AND `user_id` = OLD.`user_id`) AND NOT EXISTS (SELECT 1 FROM `asset_account` WHERE `id` = OLD.`account_id` AND `user_id` = OLD.`user_id` AND typeof(`balance_amount`) = 'integer' AND `balance_amount` >= -1000000000000 AND `balance_amount` <= 1000000000000) THEN RAISE(ABORT, 'asset balance out of range') END);
	SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM `asset_user_deletion_guard` WHERE `user_id` = OLD.`user_id`) AND EXISTS (SELECT 1 FROM `asset_account` WHERE `id` = OLD.`account_id` AND `user_id` = OLD.`user_id`) AND ((SELECT `balance_amount` FROM `asset_account` WHERE `id` = OLD.`account_id` AND `user_id` = OLD.`user_id`) - OLD.`amount` < -1000000000000 OR (SELECT `balance_amount` FROM `asset_account` WHERE `id` = OLD.`account_id` AND `user_id` = OLD.`user_id`) - OLD.`amount` > 1000000000000) THEN RAISE(ABORT, 'asset balance out of range') END);
	SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM `asset_user_deletion_guard` WHERE `user_id` = OLD.`user_id`) AND EXISTS (SELECT 1 FROM `asset_account` WHERE `id` = OLD.`account_id` AND `user_id` = OLD.`user_id`) AND ((SELECT COALESCE(SUM(`balance_amount`), 0) FROM `asset_account` WHERE `user_id` = OLD.`user_id`) - OLD.`amount` < -1000000000000 OR (SELECT COALESCE(SUM(`balance_amount`), 0) FROM `asset_account` WHERE `user_id` = OLD.`user_id`) - OLD.`amount` > 1000000000000) THEN RAISE(ABORT, 'asset aggregate out of range') END);
END;
--> statement-breakpoint
DROP TRIGGER `asset_entry_balance_reverse`;
--> statement-breakpoint
CREATE TRIGGER `asset_entry_balance_reverse`
AFTER DELETE ON `asset_entry`
WHEN NOT EXISTS (SELECT 1 FROM `asset_user_deletion_guard` WHERE `user_id` = OLD.`user_id`)
BEGIN
	UPDATE `asset_account` SET `balance_amount` = `balance_amount` - OLD.`amount`, `updated_at` = OLD.`created_at` WHERE `id` = OLD.`account_id` AND `user_id` = OLD.`user_id`;
END;
