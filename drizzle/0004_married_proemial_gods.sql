CREATE TABLE "case_studies" (
	"id" serial PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"source_kind" text DEFAULT 'story' NOT NULL,
	"category" text,
	"business_model" text,
	"revenue_month" numeric(14, 2),
	"revenue_note" text,
	"founded_year" integer,
	"summary" text,
	"snapshot_hash" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"extraction" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "case_studies_url_key" ON "case_studies" USING btree ("url");--> statement-breakpoint
CREATE INDEX "case_studies_slug_idx" ON "case_studies" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "case_studies_revenue_idx" ON "case_studies" USING btree ("revenue_month");