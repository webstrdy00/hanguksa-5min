CREATE TABLE "admin_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_admin_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_audit_logs_action_check" CHECK ("admin_audit_logs"."action" in ('create_revision', 'publish_question', 'retire_question', 'void_question', 'update_exam_schedule', 'resolve_report', 'publish_correction', 'toggle_feature_flag', 'process_deletion'))
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_users_role_check" CHECK ("admin_users"."role" in ('reviewer', 'editor', 'admin')),
	CONSTRAINT "admin_users_status_check" CHECK ("admin_users"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "exam_schedule_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_schedule_id" uuid NOT NULL,
	"changed_by" uuid,
	"change_reason" text NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb NOT NULL,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_schedule_audits_reason_check" CHECK (length("exam_schedule_audits"."change_reason") > 0)
);
--> statement-breakpoint
CREATE TABLE "exam_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"round" integer NOT NULL,
	"exam_date" date NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"source_url" text NOT NULL,
	"source_verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_schedules_type_check" CHECK ("exam_schedules"."type" in ('advanced', 'basic')),
	CONSTRAINT "exam_schedules_status_check" CHECK ("exam_schedules"."status" in ('scheduled', 'changed', 'cancelled', 'completed')),
	CONSTRAINT "exam_schedules_round_check" CHECK ("exam_schedules"."round" > 0),
	CONSTRAINT "exam_schedules_source_url_check" CHECK (length("exam_schedules"."source_url") > 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"anon_key_fingerprint" text NOT NULL,
	"anon_key_ciphertext" text,
	"anon_key_key_version" integer,
	"identity_status" text DEFAULT 'active' NOT NULL,
	"identity_verified_at" timestamp with time zone,
	"target_grade" integer,
	"target_exam_id" uuid,
	"streak_days" integer DEFAULT 0 NOT NULL,
	"last_streak_date" date,
	"app_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_identity_status_check" CHECK ("users"."identity_status" in ('active', 'deleted', 'blocked')),
	CONSTRAINT "users_target_grade_check" CHECK ("users"."target_grade" is null or "users"."target_grade" between 1 and 3),
	CONSTRAINT "users_streak_days_check" CHECK ("users"."streak_days" >= 0),
	CONSTRAINT "users_anon_key_ciphertext_pair_check" CHECK (("users"."anon_key_ciphertext" is null) = ("users"."anon_key_key_version" is null)),
	CONSTRAINT "users_deleted_at_check" CHECK (("users"."identity_status" = 'deleted') = ("users"."deleted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "correction_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"from_revision_id" uuid,
	"to_revision_id" uuid,
	"notice_type" text NOT NULL,
	"message" text NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "correction_notices_type_check" CHECK ("correction_notices"."notice_type" in ('correction', 'void')),
	CONSTRAINT "correction_notices_message_check" CHECK (length("correction_notices"."message") > 0)
);
--> statement-breakpoint
CREATE TABLE "question_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_revision_id" uuid NOT NULL,
	"reporter_user_id" uuid,
	"reason" text NOT NULL,
	"detail" text,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_reports_reason_check" CHECK ("question_reports"."reason" in ('wrong_answer', 'ambiguous', 'typo', 'outdated', 'rights', 'other')),
	CONSTRAINT "question_reports_status_check" CHECK ("question_reports"."status" in ('open', 'triaged', 'resolved', 'rejected')),
	CONSTRAINT "question_reports_detail_length_check" CHECK ("question_reports"."detail" is null or length("question_reports"."detail") <= 500),
	CONSTRAINT "question_reports_resolved_pair_check" CHECK (("question_reports"."status" in ('resolved', 'rejected')) = ("question_reports"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "question_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"era" text NOT NULL,
	"topic" text NOT NULL,
	"ability" text NOT NULL,
	"difficulty" integer NOT NULL,
	"prompt" text NOT NULL,
	"choices" jsonb NOT NULL,
	"correct_index" integer NOT NULL,
	"explanation" text NOT NULL,
	"wrong_answer_notes" jsonb,
	"memory_keyword" text,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_accessed_at" date,
	"rights_type" text DEFAULT 'unknown' NOT NULL,
	"rights_note" text,
	"reviewer_id" uuid,
	"reviewed_at" timestamp with time zone,
	"ai_generation_meta" jsonb,
	"status_reason" text,
	"status_changed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_revisions_status_check" CHECK ("question_revisions"."status" in ('draft', 'review', 'approved', 'published', 'retired', 'voided')),
	CONSTRAINT "question_revisions_era_check" CHECK ("question_revisions"."era" in ('prehistoric', 'ancient', 'goryeo', 'joseon_early', 'joseon_late', 'enlightenment', 'japanese_occupation', 'modern')),
	CONSTRAINT "question_revisions_topic_check" CHECK ("question_revisions"."topic" in ('politics', 'economy', 'society', 'culture', 'figure', 'heritage')),
	CONSTRAINT "question_revisions_ability_check" CHECK ("question_revisions"."ability" in ('fact', 'chronology', 'source_reading', 'comparison', 'causation')),
	CONSTRAINT "question_revisions_rights_type_check" CHECK ("question_revisions"."rights_type" in ('self_created', 'public_domain_verified', 'licensed', 'unknown')),
	CONSTRAINT "question_revisions_revision_check" CHECK ("question_revisions"."revision" >= 1),
	CONSTRAINT "question_revisions_difficulty_check" CHECK ("question_revisions"."difficulty" between 1 and 3),
	CONSTRAINT "question_revisions_choices_check" CHECK (jsonb_array_length("question_revisions"."choices") = 5),
	CONSTRAINT "question_revisions_correct_index_check" CHECK ("question_revisions"."correct_index" between 0 and 4),
	CONSTRAINT "question_revisions_prompt_check" CHECK (length("question_revisions"."prompt") > 0),
	CONSTRAINT "question_revisions_explanation_check" CHECK (length("question_revisions"."explanation") > 0),
	CONSTRAINT "question_revisions_publish_requirements_check" CHECK ("question_revisions"."status" <> 'published' or (
        jsonb_array_length("question_revisions"."source_refs") > 0
        and "question_revisions"."source_accessed_at" is not null
        and "question_revisions"."reviewer_id" is not null
        and "question_revisions"."reviewed_at" is not null
        and "question_revisions"."rights_type" <> 'unknown'
      ))
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"question_revision_id" uuid NOT NULL,
	"selected_index" integer NOT NULL,
	"is_correct" boolean NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answers_selected_index_check" CHECK ("answers"."selected_index" between 0 and 4)
);
--> statement-breakpoint
CREATE TABLE "mastery" (
	"user_id" uuid NOT NULL,
	"era" text NOT NULL,
	"topic" text NOT NULL,
	"seen_count" integer DEFAULT 0 NOT NULL,
	"correct_count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"recalculated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mastery_user_id_era_topic_pk" PRIMARY KEY("user_id","era","topic"),
	CONSTRAINT "mastery_era_check" CHECK ("mastery"."era" in ('prehistoric', 'ancient', 'goryeo', 'joseon_early', 'joseon_late', 'enlightenment', 'japanese_occupation', 'modern')),
	CONSTRAINT "mastery_topic_check" CHECK ("mastery"."topic" in ('politics', 'economy', 'society', 'culture', 'figure', 'heritage')),
	CONSTRAINT "mastery_counts_check" CHECK ("mastery"."seen_count" >= 0 and "mastery"."correct_count" >= 0 and "mastery"."correct_count" <= "mastery"."seen_count")
);
--> statement-breakpoint
CREATE TABLE "study_session_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"question_revision_id" uuid NOT NULL,
	"canonical_question_id" uuid NOT NULL,
	"slot_index" integer NOT NULL,
	"slot_source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "study_session_items_revision_key" UNIQUE("session_id","question_revision_id"),
	CONSTRAINT "study_session_items_slot_index_check" CHECK ("study_session_items"."slot_index" between 0 and 4),
	CONSTRAINT "study_session_items_slot_source_check" CHECK ("study_session_items"."slot_source" in ('review', 'weak', 'new'))
);
--> statement-breakpoint
CREATE TABLE "study_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"study_date" date NOT NULL,
	"target_exam_id" uuid,
	"score" integer,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "study_sessions_score_check" CHECK ("study_sessions"."score" is null or "study_sessions"."score" between 0 and 5),
	CONSTRAINT "study_sessions_completion_pair_check" CHECK (("study_sessions"."completed_at" is null) = ("study_sessions"."score" is null))
);
--> statement-breakpoint
CREATE TABLE "user_question_state" (
	"user_id" uuid NOT NULL,
	"canonical_question_id" uuid NOT NULL,
	"review_due_at" timestamp with time zone,
	"interval_step" integer DEFAULT 0 NOT NULL,
	"last_result" text NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"wrong_count" integer DEFAULT 0 NOT NULL,
	"correct_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_question_state_user_id_canonical_question_id_pk" PRIMARY KEY("user_id","canonical_question_id"),
	CONSTRAINT "user_question_state_last_result_check" CHECK ("user_question_state"."last_result" in ('correct', 'wrong')),
	CONSTRAINT "user_question_state_interval_step_check" CHECK ("user_question_state"."interval_step" between 0 and 3),
	CONSTRAINT "user_question_state_counts_check" CHECK ("user_question_state"."wrong_count" >= 0 and "user_question_state"."correct_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "deletion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deletion_jobs_status_check" CHECK ("deletion_jobs"."status" in ('requested', 'in_progress', 'completed', 'failed')),
	CONSTRAINT "deletion_jobs_completed_pair_check" CHECK (("deletion_jobs"."status" = 'completed') = ("deletion_jobs"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"description" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flags_key_check" CHECK (length("feature_flags"."key") > 0)
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text DEFAULT 'in_progress' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_state_check" CHECK ("idempotency_keys"."state" in ('in_progress', 'completed')),
	CONSTRAINT "idempotency_keys_completed_check" CHECK ("idempotency_keys"."state" <> 'completed' or "idempotency_keys"."response_status" is not null)
);
--> statement-breakpoint
CREATE TABLE "notification_consents" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"functional_agreed" boolean DEFAULT false NOT NULL,
	"functional_agreed_at" timestamp with time zone,
	"marketing_agreed" boolean DEFAULT false NOT NULL,
	"marketing_agreed_at" timestamp with time zone,
	"push_target_status" text DEFAULT 'unknown' NOT NULL,
	"last_sent_at" timestamp with time zone,
	"last_send_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_consents_functional_pair_check" CHECK ("notification_consents"."functional_agreed" = false or "notification_consents"."functional_agreed_at" is not null),
	CONSTRAINT "notification_consents_marketing_pair_check" CHECK ("notification_consents"."marketing_agreed" = false or "notification_consents"."marketing_agreed_at" is not null),
	CONSTRAINT "notification_consents_push_target_check" CHECK ("notification_consents"."push_target_status" in ('unknown', 'active', 'revoked')),
	CONSTRAINT "notification_consents_send_status_check" CHECK ("notification_consents"."last_send_status" is null or "notification_consents"."last_send_status" in ('sent', 'failed', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actor_admin_id_admin_users_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_schedule_audits" ADD CONSTRAINT "exam_schedule_audits_exam_schedule_id_exam_schedules_id_fk" FOREIGN KEY ("exam_schedule_id") REFERENCES "public"."exam_schedules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_schedule_audits" ADD CONSTRAINT "exam_schedule_audits_changed_by_admin_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_target_exam_id_exam_schedules_id_fk" FOREIGN KEY ("target_exam_id") REFERENCES "public"."exam_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_notices" ADD CONSTRAINT "correction_notices_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_notices" ADD CONSTRAINT "correction_notices_from_revision_id_question_revisions_id_fk" FOREIGN KEY ("from_revision_id") REFERENCES "public"."question_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_notices" ADD CONSTRAINT "correction_notices_to_revision_id_question_revisions_id_fk" FOREIGN KEY ("to_revision_id") REFERENCES "public"."question_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_notices" ADD CONSTRAINT "correction_notices_created_by_admin_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_reports" ADD CONSTRAINT "question_reports_question_revision_id_question_revisions_id_fk" FOREIGN KEY ("question_revision_id") REFERENCES "public"."question_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_reports" ADD CONSTRAINT "question_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_reports" ADD CONSTRAINT "question_reports_resolved_by_admin_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_revisions" ADD CONSTRAINT "question_revisions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_revisions" ADD CONSTRAINT "question_revisions_reviewer_id_admin_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_revisions" ADD CONSTRAINT "question_revisions_created_by_admin_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_created_by_admin_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_session_id_study_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."study_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_question_revision_id_question_revisions_id_fk" FOREIGN KEY ("question_revision_id") REFERENCES "public"."question_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_session_item_fk" FOREIGN KEY ("session_id","question_revision_id") REFERENCES "public"."study_session_items"("session_id","question_revision_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastery" ADD CONSTRAINT "mastery_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_session_items" ADD CONSTRAINT "study_session_items_session_id_study_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."study_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_session_items" ADD CONSTRAINT "study_session_items_question_revision_id_question_revisions_id_fk" FOREIGN KEY ("question_revision_id") REFERENCES "public"."question_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_session_items" ADD CONSTRAINT "study_session_items_canonical_question_id_questions_id_fk" FOREIGN KEY ("canonical_question_id") REFERENCES "public"."questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_target_exam_id_exam_schedules_id_fk" FOREIGN KEY ("target_exam_id") REFERENCES "public"."exam_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_question_state" ADD CONSTRAINT "user_question_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_question_state" ADD CONSTRAINT "user_question_state_canonical_question_id_questions_id_fk" FOREIGN KEY ("canonical_question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_updated_by_admin_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_consents" ADD CONSTRAINT "notification_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_logs_created_at_idx" ON "admin_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_logs_target_idx" ON "admin_audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "exam_schedule_audits_schedule_idx" ON "exam_schedule_audits" USING btree ("exam_schedule_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "exam_schedules_type_round_key" ON "exam_schedules" USING btree ("type","round");--> statement-breakpoint
CREATE INDEX "exam_schedules_exam_date_idx" ON "exam_schedules" USING btree ("exam_date");--> statement-breakpoint
CREATE INDEX "exam_schedules_status_date_idx" ON "exam_schedules" USING btree ("status","exam_date");--> statement-breakpoint
CREATE UNIQUE INDEX "users_anon_key_fingerprint_key" ON "users" USING btree ("anon_key_fingerprint");--> statement-breakpoint
CREATE INDEX "users_identity_status_idx" ON "users" USING btree ("identity_status");--> statement-breakpoint
CREATE INDEX "users_target_exam_idx" ON "users" USING btree ("target_exam_id");--> statement-breakpoint
CREATE INDEX "correction_notices_question_idx" ON "correction_notices" USING btree ("question_id","created_at");--> statement-breakpoint
CREATE INDEX "correction_notices_published_idx" ON "correction_notices" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "question_reports_triage_idx" ON "question_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "question_reports_revision_idx" ON "question_reports" USING btree ("question_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "question_revisions_question_revision_key" ON "question_revisions" USING btree ("question_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "question_revisions_one_published_idx" ON "question_revisions" USING btree ("question_id") WHERE status = 'published';--> statement-breakpoint
CREATE INDEX "question_revisions_pool_idx" ON "question_revisions" USING btree ("era","topic","difficulty") WHERE status = 'published';--> statement-breakpoint
CREATE INDEX "question_revisions_status_idx" ON "question_revisions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "answers_session_revision_key" ON "answers" USING btree ("session_id","question_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "study_session_items_slot_key" ON "study_session_items" USING btree ("session_id","slot_index");--> statement-breakpoint
CREATE INDEX "study_session_items_revision_idx" ON "study_session_items" USING btree ("question_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "study_sessions_user_date_key" ON "study_sessions" USING btree ("user_id","study_date");--> statement-breakpoint
CREATE INDEX "study_sessions_completed_idx" ON "study_sessions" USING btree ("completed_at");--> statement-breakpoint
CREATE INDEX "user_question_state_due_idx" ON "user_question_state" USING btree ("user_id","review_due_at");--> statement-breakpoint
CREATE INDEX "user_question_state_last_seen_idx" ON "user_question_state" USING btree ("user_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "deletion_jobs_status_idx" ON "deletion_jobs" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "deletion_jobs_subject_idx" ON "deletion_jobs" USING btree ("subject_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_scope_key" ON "idempotency_keys" USING btree ("user_id","endpoint","idempotency_key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "notification_consents_functional_idx" ON "notification_consents" USING btree ("push_target_status") WHERE functional_agreed = true;