CREATE TABLE "mastery_recalc_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_revision_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"total_users" integer DEFAULT 0 NOT NULL,
	"processed_users" integer DEFAULT 0 NOT NULL,
	"requested_by" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mastery_recalc_jobs_status_check" CHECK ("mastery_recalc_jobs"."status" in ('pending', 'running', 'completed', 'failed')),
	CONSTRAINT "mastery_recalc_jobs_reason_check" CHECK ("mastery_recalc_jobs"."reason" in ('question_voided', 'manual')),
	CONSTRAINT "mastery_recalc_jobs_progress_check" CHECK ("mastery_recalc_jobs"."processed_users" >= 0 and "mastery_recalc_jobs"."total_users" >= 0)
);
--> statement-breakpoint
ALTER TABLE "mastery_recalc_jobs" ADD CONSTRAINT "mastery_recalc_jobs_question_revision_id_question_revisions_id_fk" FOREIGN KEY ("question_revision_id") REFERENCES "public"."question_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastery_recalc_jobs" ADD CONSTRAINT "mastery_recalc_jobs_requested_by_admin_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mastery_recalc_jobs_status_idx" ON "mastery_recalc_jobs" USING btree ("status","created_at");