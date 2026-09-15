CREATE TABLE "build_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"uid" varchar(64) NOT NULL,
	"fc_target" varchar(64) NOT NULL,
	"trust" varchar(16) NOT NULL,
	"snapshot_id" uuid,
	"fc_firmware_id" uuid,
	"tx_firmware_id" uuid,
	"diagnostic_build_id" uuid,
	"vtx_profile_id" uuid,
	"vtx_model_id" uuid,
	"vtx_model_name" varchar(128),
	"freq_source" varchar(16) DEFAULT 'manual' NOT NULL,
	"tx_model_code" varchar(64) NOT NULL,
	"user_diff" text DEFAULT '' NOT NULL,
	"pairs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fc_script" text NOT NULL,
	"fc_bundle" text NOT NULL,
	"tx_yaml" text NOT NULL,
	"hashes" jsonb NOT NULL,
	"fc_applied" boolean DEFAULT false NOT NULL,
	"vtx_map_written" boolean DEFAULT false NOT NULL,
	"tx_applied" boolean DEFAULT false NOT NULL,
	"status" varchar(16) DEFAULT 'ready' NOT NULL,
	"crash_report_id" uuid,
	"name" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firmware_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firmware_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"uid" varchar(64) DEFAULT '' NOT NULL,
	"build_set_id" uuid,
	"crash_report_id" uuid,
	"outcome" varchar(16) NOT NULL,
	"flights" integer DEFAULT 1 NOT NULL,
	"comment" text,
	"admin_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "build_sets" ADD CONSTRAINT "build_sets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_sets" ADD CONSTRAINT "build_sets_snapshot_id_board_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."board_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_sets" ADD CONSTRAINT "build_sets_fc_firmware_id_firmware_versions_id_fk" FOREIGN KEY ("fc_firmware_id") REFERENCES "public"."firmware_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_sets" ADD CONSTRAINT "build_sets_tx_firmware_id_firmware_versions_id_fk" FOREIGN KEY ("tx_firmware_id") REFERENCES "public"."firmware_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_sets" ADD CONSTRAINT "build_sets_diagnostic_build_id_diagnostic_builds_id_fk" FOREIGN KEY ("diagnostic_build_id") REFERENCES "public"."diagnostic_builds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_sets" ADD CONSTRAINT "build_sets_vtx_profile_id_vtx_profiles_id_fk" FOREIGN KEY ("vtx_profile_id") REFERENCES "public"."vtx_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_sets" ADD CONSTRAINT "build_sets_vtx_model_id_vtx_models_id_fk" FOREIGN KEY ("vtx_model_id") REFERENCES "public"."vtx_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_sets" ADD CONSTRAINT "build_sets_crash_report_id_crash_reports_id_fk" FOREIGN KEY ("crash_report_id") REFERENCES "public"."crash_reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firmware_feedback" ADD CONSTRAINT "firmware_feedback_firmware_id_firmware_versions_id_fk" FOREIGN KEY ("firmware_id") REFERENCES "public"."firmware_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firmware_feedback" ADD CONSTRAINT "firmware_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firmware_feedback" ADD CONSTRAINT "firmware_feedback_build_set_id_build_sets_id_fk" FOREIGN KEY ("build_set_id") REFERENCES "public"."build_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firmware_feedback" ADD CONSTRAINT "firmware_feedback_crash_report_id_crash_reports_id_fk" FOREIGN KEY ("crash_report_id") REFERENCES "public"."crash_reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "build_sets_user_idx" ON "build_sets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "build_sets_uid_idx" ON "build_sets" USING btree ("uid");--> statement-breakpoint
CREATE INDEX "fw_feedback_fw_idx" ON "firmware_feedback" USING btree ("firmware_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fw_feedback_uq" ON "firmware_feedback" USING btree ("firmware_id","user_id","uid");