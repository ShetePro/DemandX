CREATE TABLE "source_usage" (
	"source" text NOT NULL,
	"window" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "source_usage_source_window_window_start_pk" PRIMARY KEY("source","window","window_start"),
	CONSTRAINT "source_usage_window_check" CHECK ("source_usage"."window" in ('minute', 'day', 'week', 'month'))
);
