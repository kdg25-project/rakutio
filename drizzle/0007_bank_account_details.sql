ALTER TABLE `asset_account` ADD COLUMN `bank_kind` text CHECK(`bank_kind` IN ('ordinary', 'checking', 'time') OR `bank_kind` IS NULL);
--> statement-breakpoint
ALTER TABLE `asset_account` ADD COLUMN `bank_memo` text;
--> statement-breakpoint
UPDATE `asset_account` SET `bank_kind` = 'ordinary' WHERE `type` = 'bank' AND `bank_kind` IS NULL;
