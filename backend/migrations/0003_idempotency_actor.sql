DROP INDEX "idempotency_keys_scope_key";--> statement-breakpoint
ALTER TABLE "idempotency_keys" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "actor_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "admin_user_id" uuid;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_scope_key" ON "idempotency_keys" USING btree ("actor_key","endpoint","idempotency_key");--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_actor_check" CHECK (("idempotency_keys"."user_id" is not null) <> ("idempotency_keys"."admin_user_id" is not null));