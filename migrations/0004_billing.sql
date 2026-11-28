CREATE TABLE `user_subscription` (
  `user_id` text PRIMARY KEY NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `polar_customer_id` text,
  `polar_subscription_id` text UNIQUE,
  `product_id` text,
  `plan` text NOT NULL DEFAULT 'free',
  `status` text NOT NULL DEFAULT 'none',
  `current_period_end` integer,
  `cancel_at_period_end` integer NOT NULL DEFAULT 0,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
CREATE INDEX `user_subscription_polar_customer_idx` ON `user_subscription` (`polar_customer_id`);
