CREATE TABLE "board_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"uid" varchar(64) NOT NULL,
	"fc_variant" varchar(8) NOT NULL,
	"fc_version" varchar(32) NOT NULL,
	"fc_target" varchar(64) NOT NULL,
	"board_id" varchar(8),
	"trust" varchar(16) NOT NULL,
	"transport" jsonb,
	"diff_all" text,
	"diff_sha256" varchar(64),
	"status_text" text,
	"vtx_config" jsonb,
	"vtx_map" jsonb,
	"capability" jsonb,
	"image_path" text,
	"image_sha256" varchar(64),
	"image_size_bytes" integer,
	"image_source" varchar(32),
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crash_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"snapshot_id" uuid,
	"diagnostic_build_id" uuid,
	"uid" varchar(64),
	"fc_target" varchar(64),
	"description" text,
	"diff_after" text,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"analysis" jsonb,
	"status" varchar(16) DEFAULT 'new' NOT NULL,
	"admin_note" text,
	"fix_firmware_id" uuid,
	"fix_diff_content" text,
	"user_verdict" varchar(16),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagnostic_builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"base_firmware_id" uuid,
	"log_path" varchar(16) NOT NULL,
	"options" jsonb NOT NULL,
	"cli_script" text NOT NULL,
	"status" varchar(16) DEFAULT 'ready' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verified_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fc_target" varchar(64) NOT NULL,
	"inav_version" varchar(32) NOT NULL,
	"board_model_id" uuid,
	"status" varchar(16) DEFAULT 'verified' NOT NULL,
	"evidence" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vtx_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid,
	"vtx_model_id" uuid,
	"user_id" uuid NOT NULL,
	"image_path" text NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"caption" varchar(255),
	"annotations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "firmware_versions" ADD COLUMN "verification" varchar(16) DEFAULT 'experimental' NOT NULL;--> statement-breakpoint
ALTER TABLE "firmware_versions" ADD COLUMN "section" varchar(64);--> statement-breakpoint
ALTER TABLE "firmware_versions" ADD COLUMN "fixes_crash_report_id" uuid;--> statement-breakpoint
ALTER TABLE "firmware_versions" ADD COLUMN "withdrawn_reason" text;--> statement-breakpoint
ALTER TABLE "vtx_submissions" ADD COLUMN "raw_log" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "vtx_submissions" ADD COLUMN "freq_source" varchar(16) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "vtx_submissions" ADD COLUMN "freq_file" jsonb;--> statement-breakpoint
ALTER TABLE "vtx_submissions" ADD COLUMN "fc_target" varchar(64);--> statement-breakpoint
ALTER TABLE "vtx_submissions" ADD COLUMN "fc_version" varchar(32);--> statement-breakpoint
ALTER TABLE "board_snapshots" ADD CONSTRAINT "board_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_snapshots" ADD CONSTRAINT "board_snapshots_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_reports" ADD CONSTRAINT "crash_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_reports" ADD CONSTRAINT "crash_reports_snapshot_id_board_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."board_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_reports" ADD CONSTRAINT "crash_reports_diagnostic_build_id_diagnostic_builds_id_fk" FOREIGN KEY ("diagnostic_build_id") REFERENCES "public"."diagnostic_builds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_reports" ADD CONSTRAINT "crash_reports_fix_firmware_id_firmware_versions_id_fk" FOREIGN KEY ("fix_firmware_id") REFERENCES "public"."firmware_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnostic_builds" ADD CONSTRAINT "diagnostic_builds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnostic_builds" ADD CONSTRAINT "diagnostic_builds_snapshot_id_board_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."board_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnostic_builds" ADD CONSTRAINT "diagnostic_builds_base_firmware_id_firmware_versions_id_fk" FOREIGN KEY ("base_firmware_id") REFERENCES "public"."firmware_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_targets" ADD CONSTRAINT "verified_targets_board_model_id_board_models_id_fk" FOREIGN KEY ("board_model_id") REFERENCES "public"."board_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_targets" ADD CONSTRAINT "verified_targets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vtx_photos" ADD CONSTRAINT "vtx_photos_submission_id_vtx_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."vtx_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vtx_photos" ADD CONSTRAINT "vtx_photos_vtx_model_id_vtx_models_id_fk" FOREIGN KEY ("vtx_model_id") REFERENCES "public"."vtx_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vtx_photos" ADD CONSTRAINT "vtx_photos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "snapshots_user_idx" ON "board_snapshots" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "snapshots_uid_idx" ON "board_snapshots" USING btree ("uid");--> statement-breakpoint
CREATE INDEX "crash_user_idx" ON "crash_reports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "crash_status_idx" ON "crash_reports" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "verified_targets_uq" ON "verified_targets" USING btree ("fc_target","inav_version");--> statement-breakpoint
CREATE INDEX "vtx_photos_model_idx" ON "vtx_photos" USING btree ("vtx_model_id");--> statement-breakpoint
CREATE INDEX "vtx_photos_sub_idx" ON "vtx_photos" USING btree ("submission_id");