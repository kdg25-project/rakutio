ALTER TABLE `user` ADD COLUMN `theme` text NOT NULL DEFAULT 'sage';
--> statement-breakpoint
ALTER TABLE `user` ADD COLUMN `memo` text NOT NULL DEFAULT '';
