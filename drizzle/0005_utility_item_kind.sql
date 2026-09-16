ALTER TABLE `ledger_transaction_item` ADD COLUMN `utility_kind` text CHECK(`utility_kind` IN ('electricity', 'gas', 'water', 'other'));
