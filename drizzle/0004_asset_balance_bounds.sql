-- Keep all persisted asset balances inside an exact JavaScript integer domain.
-- 1e12 also keeps every intermediate trigger calculation well below SQLite's
-- signed 64-bit integer limit.
CREATE TRIGGER `asset_account_insert_balance_guard`
BEFORE INSERT ON `asset_account`
BEGIN
	SELECT (CASE WHEN typeof(NEW.`balance_amount`) <> 'integer' OR NEW.`balance_amount` < -1000000000000 OR NEW.`balance_amount` > 1000000000000 THEN RAISE(ABORT, 'asset balance out of range') END);
	SELECT (CASE WHEN NEW.`type` = 'gift' AND NEW.`balance_amount` < 0 THEN RAISE(ABORT, 'gift balance insufficient') END);
	SELECT (CASE WHEN (SELECT COALESCE(SUM(`balance_amount`), 0) FROM `asset_account` WHERE `user_id` = NEW.`user_id`) + NEW.`balance_amount` < -1000000000000 OR (SELECT COALESCE(SUM(`balance_amount`), 0) FROM `asset_account` WHERE `user_id` = NEW.`user_id`) + NEW.`balance_amount` > 1000000000000 THEN RAISE(ABORT, 'asset aggregate out of range') END);
END;
--> statement-breakpoint
CREATE TRIGGER `asset_account_update_balance_guard`
BEFORE UPDATE OF `balance_amount` ON `asset_account`
BEGIN
	SELECT (CASE WHEN typeof(NEW.`balance_amount`) <> 'integer' OR NEW.`balance_amount` < -1000000000000 OR NEW.`balance_amount` > 1000000000000 THEN RAISE(ABORT, 'asset balance out of range') END);
	SELECT (CASE WHEN NEW.`type` = 'gift' AND NEW.`balance_amount` < 0 THEN RAISE(ABORT, 'gift balance insufficient') END);
	SELECT (CASE WHEN (SELECT COALESCE(SUM(`balance_amount`), 0) FROM `asset_account` WHERE `user_id` = NEW.`user_id` AND `id` <> NEW.`id`) + NEW.`balance_amount` < -1000000000000 OR (SELECT COALESCE(SUM(`balance_amount`), 0) FROM `asset_account` WHERE `user_id` = NEW.`user_id` AND `id` <> NEW.`id`) + NEW.`balance_amount` > 1000000000000 THEN RAISE(ABORT, 'asset aggregate out of range') END);
END;
--> statement-breakpoint
CREATE TRIGGER `asset_entry_bounds_insert_guard`
BEFORE INSERT ON `asset_entry`
BEGIN
	SELECT (CASE WHEN typeof(NEW.`amount`) <> 'integer' OR NEW.`amount` < -1000000000000 OR NEW.`amount` > 1000000000000 THEN RAISE(ABORT, 'asset entry amount out of range') END);
	SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM `asset_account` WHERE `id` = NEW.`account_id` AND `user_id` = NEW.`user_id` AND typeof(`balance_amount`) = 'integer' AND `balance_amount` >= -1000000000000 AND `balance_amount` <= 1000000000000) THEN RAISE(ABORT, 'asset balance out of range') END);
	SELECT (CASE WHEN (SELECT `balance_amount` FROM `asset_account` WHERE `id` = NEW.`account_id` AND `user_id` = NEW.`user_id`) + NEW.`amount` < -1000000000000 OR (SELECT `balance_amount` FROM `asset_account` WHERE `id` = NEW.`account_id` AND `user_id` = NEW.`user_id`) + NEW.`amount` > 1000000000000 THEN RAISE(ABORT, 'asset balance out of range') END);
	SELECT (CASE WHEN (SELECT COALESCE(SUM(`balance_amount`), 0) FROM `asset_account` WHERE `user_id` = NEW.`user_id`) + NEW.`amount` < -1000000000000 OR (SELECT COALESCE(SUM(`balance_amount`), 0) FROM `asset_account` WHERE `user_id` = NEW.`user_id`) + NEW.`amount` > 1000000000000 THEN RAISE(ABORT, 'asset aggregate out of range') END);
END;
--> statement-breakpoint
CREATE TRIGGER `asset_entry_bounds_delete_guard`
BEFORE DELETE ON `asset_entry`
BEGIN
	SELECT (CASE WHEN typeof(OLD.`amount`) <> 'integer' OR OLD.`amount` < -1000000000000 OR OLD.`amount` > 1000000000000 THEN RAISE(ABORT, 'asset entry amount out of range') END);
	SELECT (CASE WHEN EXISTS (SELECT 1 FROM `asset_account` WHERE `id` = OLD.`account_id` AND `user_id` = OLD.`user_id`) AND NOT EXISTS (SELECT 1 FROM `asset_account` WHERE `id` = OLD.`account_id` AND `user_id` = OLD.`user_id` AND typeof(`balance_amount`) = 'integer' AND `balance_amount` >= -1000000000000 AND `balance_amount` <= 1000000000000) THEN RAISE(ABORT, 'asset balance out of range') END);
	SELECT (CASE WHEN EXISTS (SELECT 1 FROM `asset_account` WHERE `id` = OLD.`account_id` AND `user_id` = OLD.`user_id`) AND ((SELECT `balance_amount` FROM `asset_account` WHERE `id` = OLD.`account_id` AND `user_id` = OLD.`user_id`) - OLD.`amount` < -1000000000000 OR (SELECT `balance_amount` FROM `asset_account` WHERE `id` = OLD.`account_id` AND `user_id` = OLD.`user_id`) - OLD.`amount` > 1000000000000) THEN RAISE(ABORT, 'asset balance out of range') END);
	SELECT (CASE WHEN EXISTS (SELECT 1 FROM `asset_account` WHERE `id` = OLD.`account_id` AND `user_id` = OLD.`user_id`) AND ((SELECT COALESCE(SUM(`balance_amount`), 0) FROM `asset_account` WHERE `user_id` = OLD.`user_id`) - OLD.`amount` < -1000000000000 OR (SELECT COALESCE(SUM(`balance_amount`), 0) FROM `asset_account` WHERE `user_id` = OLD.`user_id`) - OLD.`amount` > 1000000000000) THEN RAISE(ABORT, 'asset aggregate out of range') END);
END;
