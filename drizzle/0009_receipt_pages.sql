CREATE TABLE `receipt_page` (
	`receipt_id` text NOT NULL,
	`page_index` integer NOT NULL,
	`object_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`analysis_status` text DEFAULT 'pending' NOT NULL CHECK(`analysis_status` IN ('pending', 'analyzed', 'failed')),
	`analysis_json` text,
	`error_code` text,
	`error_message` text,
	`analyzed_at` integer,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipt`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_page_object_key_unique` ON `receipt_page` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_page_receipt_index_unique` ON `receipt_page` (`receipt_id`,`page_index`);--> statement-breakpoint
CREATE INDEX `receipt_page_receipt_status_idx` ON `receipt_page` (`receipt_id`,`analysis_status`);--> statement-breakpoint
INSERT INTO `receipt_page` (`receipt_id`, `page_index`, `object_key`, `mime_type`, `byte_size`, `analysis_status`, `analysis_json`, `analyzed_at`)
SELECT `id`, 0, `object_key`, `mime_type`, `byte_size`,
	CASE WHEN `analysis_status` = 'analyzed' THEN 'analyzed' WHEN `analysis_status` = 'failed' THEN 'failed' ELSE 'pending' END,
	`analysis_json`, `analyzed_at`
FROM `receipt`;
