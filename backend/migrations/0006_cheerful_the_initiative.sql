CREATE TABLE "deletion_restore_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"dataset_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"replayed_ordinal" integer DEFAULT 0 NOT NULL,
	"journal_enforced" boolean DEFAULT false NOT NULL,
	CONSTRAINT "deletion_restore_state_singleton" CHECK ("deletion_restore_state"."id" = 1),
	CONSTRAINT "deletion_restore_state_ordinal" CHECK ("deletion_restore_state"."replayed_ordinal" >= 0)
);
--> statement-breakpoint
INSERT INTO deletion_restore_state (id) VALUES (1);
--> statement-breakpoint
CREATE FUNCTION guard_deletion_journal_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT journal_enforced FROM deletion_restore_state WHERE id = 1)
     AND current_setting('app.deletion_journal_recorded', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'DELETION_JOURNAL_REQUIRED';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER deletion_journal_write_fence BEFORE INSERT ON deletion_jobs
FOR EACH ROW EXECUTE FUNCTION guard_deletion_journal_admission();
