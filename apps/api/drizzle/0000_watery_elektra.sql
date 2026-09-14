CREATE TABLE "activation_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"type" varchar(3) NOT NULL,
	"plan_code" varchar(32) NOT NULL,
	"duration_days" integer NOT NULL,
	"device_limit" integer NOT NULL,
	"max_redemptions" integer DEFAULT 1 NOT NULL,
	"redemptions" integer DEFAULT 0 NOT NULL,
	"is_revoked" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"note" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "active_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" varchar(64) NOT NULL,
	"role" varchar(16) DEFAULT 'operator' NOT NULL,
	"device_label" varchar(128),
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "addon_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subscription_id" uuid,
	"addon_id" uuid NOT NULL,
	"payment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"action" varchar(64) NOT NULL,
	"target" varchar(128),
	"ip" varchar(64),
	"fingerprint" varchar(128),
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "autoflash_log_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"level" varchar(8) DEFAULT 'info' NOT NULL,
	"step" varchar(32),
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "autoflash_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"preset_id" uuid,
	"board_uid" varchar(64),
	"fc_target" varchar(64),
	"from_version" varchar(32),
	"to_version" varchar(32),
	"status" varchar(16) DEFAULT 'running' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "board_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"fc_target" varchar(64) NOT NULL,
	"total_pins" integer DEFAULT 12 NOT NULL,
	"description" text,
	"default_diff_template_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_models_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "board_pin_layouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_model_id" uuid,
	"fc_target" varchar(64) NOT NULL,
	"image_path" text,
	"total_pins" integer NOT NULL,
	"pins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"fc_target" varchar(64),
	"detected" jsonb,
	"photo_path" text,
	"layout_id" uuid,
	"status" varchar(24) DEFAULT 'pending_review' NOT NULL,
	"moderator_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cms_content" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"locale" varchar(8) DEFAULT 'ru' NOT NULL,
	"content" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"ip" varchar(64),
	"fingerprint" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"uid" varchar(64) NOT NULL,
	"model_id" uuid,
	"name" varchar(64),
	"firmware_version" varchar(32),
	"auth_token_hash" varchar(128),
	"auth_expires_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"backup" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diff_share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"diff_id" uuid NOT NULL,
	"token" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diff_share_links_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "diff_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" varchar(32) NOT NULL,
	"content" text NOT NULL,
	"changelog" text,
	"parsed" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diff_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(128) NOT NULL,
	"board_model_id" uuid,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"current_version_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diff_usage_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"diff_id" uuid,
	"template_id" uuid,
	"action" varchar(24) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"email" varchar(255),
	"subject" varchar(255),
	"message" text NOT NULL,
	"status" varchar(16) DEFAULT 'new' NOT NULL,
	"admin_reply" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firmware_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(16) NOT NULL,
	"target" varchar(64) NOT NULL,
	"version" varchar(32) NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"file_path" text NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"size_bytes" integer NOT NULL,
	"changelog" text,
	"is_published" boolean DEFAULT false NOT NULL,
	"model_ids" jsonb DEFAULT '[]'::jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flash_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"allowed_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inav_version" varchar(32) DEFAULT 'latest' NOT NULL,
	"firmware_id" uuid,
	"diff_id" uuid,
	"osd_profile" jsonb,
	"vtx_profile_id" uuid,
	"arming_config" jsonb,
	"options" jsonb DEFAULT '{"skipIfSame":true,"applyDiff":true,"applyOsd":true,"applyVtx":true,"autoEepromWrite":true,"syncTransmitter":true}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "frequency_ranges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(16) NOT NULL,
	"name" varchar(64) NOT NULL,
	"min_mhz" integer NOT NULL,
	"max_mhz" integer NOT NULL,
	"status" varchar(16) DEFAULT 'in_dev' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "frequency_ranges_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "news_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(128) NOT NULL,
	"title" varchar(255) NOT NULL,
	"body" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"firmware_version" varchar(32),
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "news_posts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(16) NOT NULL,
	"provider_payment_id" varchar(128),
	"amount_rub" integer NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"purpose" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_addons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(64) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"amount" integer DEFAULT 1 NOT NULL,
	"price_rub" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "plan_addons_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(64) NOT NULL,
	"duration_days" integer DEFAULT 30 NOT NULL,
	"device_limit" integer DEFAULT 3 NOT NULL,
	"price_rub" integer DEFAULT 0 NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"source" varchar(16) NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"device_limit" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transmitter_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"platform" varchar(32) NOT NULL,
	"firmware_target" varchar(64),
	"display" varchar(64),
	"channels" integer DEFAULT 16 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transmitter_models_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "usage_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"event" varchar(48) NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_diff_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"diff_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_diffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"board_model_id" uuid,
	"parent_template_id" uuid,
	"is_active" boolean DEFAULT false NOT NULL,
	"draft" text,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" varchar(128) NOT NULL,
	"fingerprint" varchar(128),
	"ip" varchar(64),
	"user_agent" text,
	"role" varchar(16) DEFAULT 'operator' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"email_verify_token" varchar(64),
	"role" varchar(16) DEFAULT 'user' NOT NULL,
	"fingerprint" varchar(128),
	"registered_ip" varchar(64),
	"totp_secret_enc" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"backup_codes_hash" jsonb DEFAULT '[]'::jsonb,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vtx_auto_detections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"fc_target" varchar(64),
	"fc_version" varchar(32),
	"vtx_config" jsonb,
	"vtx_info" jsonb,
	"matched_vtx_model_id" uuid,
	"log" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vtx_connection_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vtx_model_id" uuid NOT NULL,
	"fc_target" varchar(64) NOT NULL,
	"image_path" text NOT NULL,
	"annotations" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vtx_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(128) NOT NULL,
	"manufacturer" varchar(128),
	"range_id" uuid,
	"protocol" varchar(32) DEFAULT 'smartaudio' NOT NULL,
	"bands" integer NOT NULL,
	"channels" integer NOT NULL,
	"freq_table" jsonb NOT NULL,
	"power_levels" jsonb DEFAULT '[]'::jsonb,
	"raw_status_sample" text,
	"is_disabled" boolean DEFAULT false NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"source_submission_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vtx_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"vtx_model_id" uuid,
	"name" varchar(128) NOT NULL,
	"pairs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vtx_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"vtx_model_id" uuid,
	"category" varchar(24) NOT NULL,
	"message" text NOT NULL,
	"context" jsonb,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"admin_reply" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vtx_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"manufacturer" varchar(128),
	"range_id" uuid,
	"protocol" varchar(32),
	"freq_table" jsonb NOT NULL,
	"cli_status_hex" text,
	"parsed_status" jsonb,
	"auto_detection" jsonb,
	"status" varchar(24) DEFAULT 'pending_review' NOT NULL,
	"moderator_note" text,
	"result_vtx_model_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vtx_sync_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"device_id" uuid,
	"direction" varchar(16) NOT NULL,
	"payload" jsonb,
	"ok" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activation_codes" ADD CONSTRAINT "activation_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_sessions" ADD CONSTRAINT "active_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addon_purchases" ADD CONSTRAINT "addon_purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addon_purchases" ADD CONSTRAINT "addon_purchases_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addon_purchases" ADD CONSTRAINT "addon_purchases_addon_id_plan_addons_id_fk" FOREIGN KEY ("addon_id") REFERENCES "public"."plan_addons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autoflash_log_entries" ADD CONSTRAINT "autoflash_log_entries_run_id_autoflash_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."autoflash_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autoflash_runs" ADD CONSTRAINT "autoflash_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autoflash_runs" ADD CONSTRAINT "autoflash_runs_preset_id_flash_presets_id_fk" FOREIGN KEY ("preset_id") REFERENCES "public"."flash_presets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_pin_layouts" ADD CONSTRAINT "board_pin_layouts_board_model_id_board_models_id_fk" FOREIGN KEY ("board_model_id") REFERENCES "public"."board_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_submissions" ADD CONSTRAINT "board_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_submissions" ADD CONSTRAINT "board_submissions_layout_id_board_pin_layouts_id_fk" FOREIGN KEY ("layout_id") REFERENCES "public"."board_pin_layouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_redemptions" ADD CONSTRAINT "code_redemptions_code_id_activation_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."activation_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_redemptions" ADD CONSTRAINT "code_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diff_share_links" ADD CONSTRAINT "diff_share_links_diff_id_user_diffs_id_fk" FOREIGN KEY ("diff_id") REFERENCES "public"."user_diffs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diff_template_versions" ADD CONSTRAINT "diff_template_versions_template_id_diff_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."diff_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diff_templates" ADD CONSTRAINT "diff_templates_board_model_id_board_models_id_fk" FOREIGN KEY ("board_model_id") REFERENCES "public"."board_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diff_templates" ADD CONSTRAINT "diff_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diff_usage_log" ADD CONSTRAINT "diff_usage_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_messages" ADD CONSTRAINT "feedback_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firmware_versions" ADD CONSTRAINT "firmware_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flash_presets" ADD CONSTRAINT "flash_presets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flash_presets" ADD CONSTRAINT "flash_presets_firmware_id_firmware_versions_id_fk" FOREIGN KEY ("firmware_id") REFERENCES "public"."firmware_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flash_presets" ADD CONSTRAINT "flash_presets_vtx_profile_id_vtx_profiles_id_fk" FOREIGN KEY ("vtx_profile_id") REFERENCES "public"."vtx_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_posts" ADD CONSTRAINT "news_posts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_diff_versions" ADD CONSTRAINT "user_diff_versions_diff_id_user_diffs_id_fk" FOREIGN KEY ("diff_id") REFERENCES "public"."user_diffs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_diffs" ADD CONSTRAINT "user_diffs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_diffs" ADD CONSTRAINT "user_diffs_board_model_id_board_models_id_fk" FOREIGN KEY ("board_model_id") REFERENCES "public"."board_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_diffs" ADD CONSTRAINT "user_diffs_parent_template_id_diff_templates_id_fk" FOREIGN KEY ("parent_template_id") REFERENCES "public"."diff_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vtx_auto_detections" ADD CONSTRAINT "vtx_auto_detections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vtx_connection_photos" ADD CONSTRAINT "vtx_connection_photos_vtx_model_id_vtx_models_id_fk" FOREIGN KEY ("vtx_model_id") REFERENCES "public"."vtx_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vtx_models" ADD CONSTRAINT "vtx_models_range_id_frequency_ranges_id_fk" FOREIGN KEY ("range_id") REFERENCES "public"."frequency_ranges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vtx_profiles" ADD CONSTRAINT "vtx_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vtx_profiles" ADD CONSTRAINT "vtx_profiles_vtx_model_id_vtx_models_id_fk" FOREIGN KEY ("vtx_model_id") REFERENCES "public"."vtx_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vtx_reports" ADD CONSTRAINT "vtx_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vtx_reports" ADD CONSTRAINT "vtx_reports_vtx_model_id_vtx_models_id_fk" FOREIGN KEY ("vtx_model_id") REFERENCES "public"."vtx_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vtx_submissions" ADD CONSTRAINT "vtx_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vtx_submissions" ADD CONSTRAINT "vtx_submissions_range_id_frequency_ranges_id_fk" FOREIGN KEY ("range_id") REFERENCES "public"."frequency_ranges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vtx_sync_log" ADD CONSTRAINT "vtx_sync_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vtx_sync_log" ADD CONSTRAINT "vtx_sync_log_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "codes_code_uq" ON "activation_codes" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_uid_uq" ON "devices" USING btree ("uid");--> statement-breakpoint
CREATE INDEX "devices_user_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "fw_target_idx" ON "firmware_versions" USING btree ("kind","target");--> statement-breakpoint
CREATE INDEX "subs_user_idx" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_fp_idx" ON "users" USING btree ("fingerprint");