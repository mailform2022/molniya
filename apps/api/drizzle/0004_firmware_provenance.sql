ALTER TABLE "firmware_versions" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
ALTER TABLE "firmware_versions" ADD COLUMN "flight_evidence_note" text;