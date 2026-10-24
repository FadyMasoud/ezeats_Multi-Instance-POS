CREATE TYPE "public"."check_status" AS ENUM('open', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."pos_error_kind" AS ENUM('server_error', 'rate_limited', 'rejected', 'timeout', 'network', 'unexpected', 'retries_exhausted');--> statement-breakpoint
CREATE TYPE "public"."pos_operation" AS ENUM('create', 'lookup', 'cancel');--> statement-breakpoint
CREATE TYPE "public"."pos_order_status" AS ENUM('open', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."pos_sync_state" AS ENUM('pending', 'reconciling', 'cancelling', 'synced', 'cancelled', 'failed');--> statement-breakpoint
CREATE TABLE "check_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"check_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL,
	CONSTRAINT "check_items_check_position_uq" UNIQUE("check_id","position"),
	CONSTRAINT "check_items_quantity_positive" CHECK ("check_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" text NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"status" "check_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checks_status_timestamps" CHECK (("checks"."status" <> 'cancelled' OR "checks"."cancelled_at" IS NOT NULL) AND ("checks"."status" <> 'paid' OR "checks"."paid_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "pos_rate_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"restaurant_id" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_restaurant_throttle" (
	"restaurant_id" text PRIMARY KEY NOT NULL,
	"blocked_until" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_sync" (
	"check_id" uuid PRIMARY KEY NOT NULL,
	"restaurant_id" text NOT NULL,
	"external_ref" text NOT NULL,
	"state" "pos_sync_state" DEFAULT 'pending' NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"pos_order_id" text,
	"pos_order_status" "pos_order_status",
	"extra_order_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"create_sent_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"manual_retry_count" integer DEFAULT 0 NOT NULL,
	"last_error_kind" "pos_error_kind",
	"last_error_message" text,
	"last_error_status" integer,
	"last_error_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_sync_external_ref_uq" UNIQUE("external_ref"),
	CONSTRAINT "pos_sync_counters_non_negative" CHECK ("pos_sync"."attempt_count" >= 0 AND "pos_sync"."consecutive_failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pos_sync_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"check_id" uuid NOT NULL,
	"operation" "pos_operation" NOT NULL,
	"ok" boolean NOT NULL,
	"error_kind" "pos_error_kind",
	"http_status" integer,
	"message" text,
	"pos_order_id" text,
	"instance_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "check_items" ADD CONSTRAINT "check_items_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sync" ADD CONSTRAINT "pos_sync_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sync_attempts" ADD CONSTRAINT "pos_sync_attempts_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checks_restaurant_idx" ON "checks" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "pos_rate_events_restaurant_sent_idx" ON "pos_rate_events" USING btree ("restaurant_id","sent_at");--> statement-breakpoint
CREATE INDEX "pos_sync_due_idx" ON "pos_sync" USING btree ("next_attempt_at") WHERE "pos_sync"."state" IN ('pending', 'reconciling', 'cancelling');--> statement-breakpoint
CREATE INDEX "pos_sync_restaurant_idx" ON "pos_sync" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "pos_sync_state_idx" ON "pos_sync" USING btree ("state");--> statement-breakpoint
CREATE INDEX "pos_sync_attempts_check_idx" ON "pos_sync_attempts" USING btree ("check_id","started_at");