CREATE TABLE "journal_entries" (
	"subject_user_id" uuid PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "journal_entries_ordinal_unique" UNIQUE("ordinal"),
	CONSTRAINT "journal_entries_ordinal_check" CHECK ("journal_entries"."ordinal" > 0)
);
--> statement-breakpoint
CREATE TABLE "journal_metadata" (
	"id" integer PRIMARY KEY NOT NULL,
	"journal_id" uuid NOT NULL,
	"dataset_id" uuid NOT NULL,
	"initialized" boolean DEFAULT false NOT NULL,
	"entry_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "journal_metadata_journal_id_unique" UNIQUE("journal_id"),
	CONSTRAINT "journal_metadata_singleton_check" CHECK ("journal_metadata"."id" = 1),
	CONSTRAINT "journal_metadata_entry_count_check" CHECK ("journal_metadata"."entry_count" >= 0)
);
--> statement-breakpoint
CREATE FUNCTION reject_journal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DELETION_JOURNAL_IMMUTABLE';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries
FOR EACH ROW EXECUTE FUNCTION reject_journal_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries
FOR EACH STATEMENT EXECUTE FUNCTION reject_journal_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_metadata_no_delete BEFORE DELETE ON journal_metadata
FOR EACH ROW EXECUTE FUNCTION reject_journal_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_metadata_no_truncate BEFORE TRUNCATE ON journal_metadata
FOR EACH STATEMENT EXECUTE FUNCTION reject_journal_mutation();
--> statement-breakpoint
CREATE FUNCTION guard_journal_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.journal_id <> OLD.journal_id OR NEW.dataset_id <> OLD.dataset_id
     OR NEW.id <> OLD.id OR (OLD.initialized AND NOT NEW.initialized)
     OR NEW.entry_count < OLD.entry_count THEN
    RAISE EXCEPTION 'DELETION_JOURNAL_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_metadata_identity BEFORE UPDATE ON journal_metadata
FOR EACH ROW EXECUTE FUNCTION guard_journal_identity();
