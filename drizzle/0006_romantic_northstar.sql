CREATE TABLE "discovery_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"scan_id" integer,
	"opportunity_title" text NOT NULL,
	"angle" text,
	"thread_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_scans" (
	"id" serial PRIMARY KEY NOT NULL,
	"angles" jsonb NOT NULL,
	"queries" jsonb NOT NULL,
	"source_urls" jsonb NOT NULL,
	"opportunities" jsonb NOT NULL,
	"trend_titles" jsonb NOT NULL,
	"strategy" text NOT NULL,
	"model" text,
	"elapsed_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discovery_feedback" ADD CONSTRAINT "discovery_feedback_scan_id_discovery_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."discovery_scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_feedback" ADD CONSTRAINT "discovery_feedback_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;