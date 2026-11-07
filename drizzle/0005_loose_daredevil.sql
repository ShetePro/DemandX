CREATE TABLE "case_ideas" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"domain" text,
	"revenue_month" numeric(14, 2),
	"revenue_source" text,
	"solo_score" integer,
	"models" text[] DEFAULT '{}' NOT NULL,
	"growth" text[] DEFAULT '{}' NOT NULL,
	"customers" text[] DEFAULT '{}' NOT NULL,
	"tools" text[] DEFAULT '{}' NOT NULL,
	"facts" text[] DEFAULT '{}' NOT NULL,
	"source_url" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"enrichment" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "case_ideas_slug_key" ON "case_ideas" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "case_ideas_revenue_idx" ON "case_ideas" USING btree ("revenue_month");