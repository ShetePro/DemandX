CREATE TYPE "public"."signal" AS ENUM('problem', 'seeking', 'paying', 'switching', 'recurring');--> statement-breakpoint
CREATE TABLE "citations" (
	"report_id" integer NOT NULL,
	"report_path" text NOT NULL,
	"evidence_id" integer NOT NULL,
	CONSTRAINT "citations_report_id_report_path_pk" PRIMARY KEY("report_id","report_path")
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"name" text,
	"positioning" text,
	"independent_sources" integer DEFAULT 0 NOT NULL,
	"evidence_ids" integer[] DEFAULT '{}'::integer[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"sections" jsonb NOT NULL,
	"rubric_total" integer NOT NULL,
	"credibility_grade" text NOT NULL,
	"decision" text NOT NULL,
	"unknowns" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_run_id_unique" UNIQUE("run_id"),
	CONSTRAINT "reports_credibility_grade_check" CHECK ("reports"."credibility_grade" in ('A', 'B', 'C', 'D'))
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"opportunity_id" integer NOT NULL,
	"dimension" text NOT NULL,
	"points" integer NOT NULL,
	"rationale" text,
	"evidence_ids" integer[] DEFAULT '{}'::integer[],
	CONSTRAINT "scores_opportunity_id_dimension_pk" PRIMARY KEY("opportunity_id","dimension"),
	CONSTRAINT "scores_points_range_check" CHECK ("scores"."points" between 0 and 20)
);
--> statement-breakpoint
CREATE TABLE "ideas" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"raw_input" text NOT NULL,
	"constraints" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" in ('user', 'assistant', 'system'))
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"idea_id" integer NOT NULL,
	"thread_id" integer,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text,
	"deadline_at" timestamp with time zone,
	"chain_snapshot" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"idea_id" integer NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"source_id" integer NOT NULL,
	"quote" text NOT NULL,
	"quote_offset" integer,
	"platform" text NOT NULL,
	"published_at" timestamp with time zone,
	"signal" "signal" NOT NULL,
	"first_hand" boolean DEFAULT false NOT NULL,
	"price_mentioned" jsonb,
	"supports" text,
	"does_not_prove" text,
	"rejected_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queries" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"angle" text,
	"provider" text,
	"text" text,
	"result_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"canonical_url" text NOT NULL,
	"platform" text NOT NULL,
	"fetched_at" timestamp with time zone,
	"content_hash" text NOT NULL,
	"snapshot_path" text,
	"http_status" integer,
	"crawl_tier" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" integer,
	"provider_id" integer,
	"model" text,
	"kind" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"allowance_usd" numeric(10, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_chains" (
	"profile" text NOT NULL,
	"position" integer NOT NULL,
	"provider_id" integer NOT NULL,
	"model_id" text NOT NULL,
	CONSTRAINT "llm_chains_profile_position_pk" PRIMARY KEY("profile","position"),
	CONSTRAINT "llm_chains_profile_check" CHECK ("llm_chains"."profile" in ('bulk', 'quality'))
);
--> statement-breakpoint
CREATE TABLE "provider_models" (
	"provider_id" integer NOT NULL,
	"model_id" text NOT NULL,
	"display_name" text,
	"context_tokens" integer,
	"supports_json" boolean DEFAULT true,
	"source" text,
	"available_externally" boolean DEFAULT true,
	CONSTRAINT "provider_models_provider_id_model_id_pk" PRIMARY KEY("provider_id","model_id")
);
--> statement-breakpoint
CREATE TABLE "provider_usage" (
	"provider_id" integer NOT NULL,
	"window" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" bigint DEFAULT 0 NOT NULL,
	"completion_tokens" bigint DEFAULT 0 NOT NULL,
	"allowance_usd" numeric(10, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "provider_usage_provider_id_window_window_start_pk" PRIMARY KEY("provider_id","window","window_start"),
	CONSTRAINT "provider_usage_window_check" CHECK ("provider_usage"."window" in ('5h', 'day', 'weekly', 'monthly'))
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_ct" text,
	"api_key_hint" text,
	"headers" jsonb DEFAULT '{}'::jsonb,
	"enabled" boolean DEFAULT true,
	"monthly_allowance_usd" numeric(10, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "providers_kind_check" CHECK ("providers"."kind" in ('openai-compatible', 'anthropic-compatible', 'google', 'ollama'))
);
--> statement-breakpoint
CREATE TABLE "validation_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"day" integer NOT NULL,
	"title" text NOT NULL,
	"done" boolean DEFAULT false,
	"evidence_id" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queries" ADD CONSTRAINT "queries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_calls" ADD CONSTRAINT "api_calls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_calls" ADD CONSTRAINT "api_calls_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_chains" ADD CONSTRAINT "llm_chains_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_models" ADD CONSTRAINT "provider_models_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_tasks" ADD CONSTRAINT "validation_tasks_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_id_seq_key" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "evidence_run_id_signal_idx" ON "evidence" USING btree ("run_id","signal");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_canonical_url_content_hash_key" ON "sources" USING btree ("canonical_url","content_hash");--> statement-breakpoint
CREATE INDEX "sources_canonical_url_idx" ON "sources" USING btree ("canonical_url");--> statement-breakpoint
CREATE INDEX "api_calls_run_id_provider_id_idx" ON "api_calls" USING btree ("run_id","provider_id");