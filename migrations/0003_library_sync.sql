CREATE TABLE `user_storage` (
  `user_id` text PRIMARY KEY NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `used_bytes` integer DEFAULT 0 NOT NULL,
  `quota_bytes` integer DEFAULT 104857600 NOT NULL,
  `sync_seq` integer DEFAULT 0 NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);

CREATE TABLE `sync_folder` (
  `user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `id` text NOT NULL,
  `name` text NOT NULL,
  `updated_at` integer NOT NULL,
  `server_seq` integer NOT NULL,
  `deleted_at` integer,
  PRIMARY KEY (`user_id`, `id`)
);
CREATE INDEX `sync_folder_user_seq_idx` ON `sync_folder` (`user_id`, `server_seq`);

CREATE TABLE `sync_drawing` (
  `user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `id` text NOT NULL,
  `name` text NOT NULL,
  `created_at` integer NOT NULL,
  `width` integer NOT NULL,
  `height` integer NOT NULL,
  `folder_id` text,
  `position` integer,
  `tags_json` text NOT NULL DEFAULT '[]',
  `visible_tag_ids_json` text,
  `updated_at` integer NOT NULL,
  `server_seq` integer NOT NULL,
  `deleted_at` integer,
  PRIMARY KEY (`user_id`, `id`)
);
CREATE INDEX `sync_drawing_user_seq_idx` ON `sync_drawing` (`user_id`, `server_seq`);

CREATE TABLE `sync_blob` (
  `user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `drawing_id` text NOT NULL,
  `kind` text NOT NULL,
  `size` integer NOT NULL,
  `mime` text NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`user_id`, `drawing_id`, `kind`)
);
CREATE INDEX `sync_blob_user_idx` ON `sync_blob` (`user_id`);
