import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { runs } from './core';

/**
 * A configured LLM endpoint. The key is stored encrypted (`api_key_ct`), with
 * a plaintext hint for masked display. `monthly_allowance_usd` is a quota
 * gauge declared by the user for third-party plans — it is not bookkeeping of
 * what a run spent.
 */
export const providers = pgTable(
  'providers',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    baseUrl: text('base_url').notNull(),
    apiKeyCt: text('api_key_ct'),
    apiKeyHint: text('api_key_hint'),
    headers: jsonb('headers').default(sql`'{}'::jsonb`),
    enabled: boolean('enabled').default(true),
    monthlyAllowanceUsd: numeric('monthly_allowance_usd', { precision: 10, scale: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check(
      'providers_kind_check',
      sql`${t.kind} in ('openai-compatible', 'anthropic-compatible', 'google', 'ollama')`,
    ),
  ],
);

/** Models discovered from a provider, cached so settings renders offline. */
export const providerModels = pgTable(
  'provider_models',
  {
    providerId: integer('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    displayName: text('display_name'),
    contextTokens: integer('context_tokens'),
    supportsJson: boolean('supports_json').default(true),
    source: text('source'),
    availableExternally: boolean('available_externally').default(true),
  },
  (t) => [primaryKey({ columns: [t.providerId, t.modelId] })],
);

/**
 * Ordered fallback chain per profile. RESTRICT on purpose: deleting a provider
 * that is still wired into a chain must be refused, not silently depopulate it.
 */
export const llmChains = pgTable(
  'llm_chains',
  {
    profile: text('profile').notNull(),
    position: integer('position').notNull(),
    providerId: integer('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'restrict' }),
    modelId: text('model_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.profile, t.position] }),
    check('llm_chains_profile_check', sql`${t.profile} in ('bulk', 'quality')`),
  ],
);

/** Rolling counters reported by the provider, used by the quota guard. */
export const providerUsage = pgTable(
  'provider_usage',
  {
    providerId: integer('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    window: text('window').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    requests: integer('requests').notNull().default(0),
    promptTokens: bigint('prompt_tokens', { mode: 'number' }).notNull().default(0),
    completionTokens: bigint('completion_tokens', { mode: 'number' }).notNull().default(0),
    allowanceUsd: numeric('allowance_usd', { precision: 10, scale: 4 }).notNull().default('0'),
  },
  (t) => [
    primaryKey({ columns: [t.providerId, t.window, t.windowStart] }),
    check('provider_usage_window_check', sql`${t.window} in ('5h', 'day', 'weekly', 'monthly')`),
  ],
);

/** Per-call ledger. `run_id`/`provider_id` are SET NULL so history outlives them. */
export const apiCalls = pgTable(
  'api_calls',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: integer('run_id').references(() => runs.id, { onDelete: 'set null' }),
    providerId: integer('provider_id').references(() => providers.id, { onDelete: 'set null' }),
    model: text('model'),
    kind: text('kind'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    allowanceUsd: numeric('allowance_usd', { precision: 10, scale: 4 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('api_calls_run_id_provider_id_idx').on(t.runId, t.providerId)],
);
