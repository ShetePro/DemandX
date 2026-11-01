# Repository Guidelines

## Project Overview

DemandX is a **local-first AI 商业机会研究 Agent**. A user describes a product idea or a
complaint in chat; a worker then runs a six-stage pipeline — S1 采集 → S2 抽取 → S3 聚类 →
S4 评分 → S5 报告 → S6 自检 — and stores the raw evidence, the rubric scores, and a report
whose every claim must cite a stored evidence row.

Stack: Next.js 16 App Router (Server Components by default), React 19, TypeScript 5.6,
PostgreSQL 16 in Docker (host port **5433**), Drizzle ORM, pg-boss for the worker queue,
AI SDK for OpenAI-compatible/Ollama chat. The app and worker run on the host; only the
database runs in Docker so local Ollama is reachable.

Everything runs on `localhost` with no accounts. LLM providers are configured in the UI
and stored in Postgres, not in environment variables. `README.md` remains the product spec;
this file only orients assistants to the code.

## Architecture & Data Flow

Navigation is conversation-first: the sidebar lists threads (state of the newest run plus
the report's score), and `/threads/[id]?view=…` switches 对话 / 证据 / 报告 / 计划 inside the
conversation. `/runs/…` stays reachable by URL and shares the same RSC panels.

```text
chat UI ──createRun──▶ runs + run_events (seq) ──SSE──▶ monitor / chat rail
   │                         │
   └──enqueue S1──▶ pg-boss ─┘
                              ▼
worker: S1 sources → S2 evidence (quote gate) → S3 opportunities → S4 scores
        → S5 report + citations (evidence whitelist) → S6 self-check
                              ▼
        /threads/<id>?view=chat|evidence|report|plan  (one page, four views)
        /runs/<id>/report · /runs/<id>/evidence · /runs/<id>/plan  (same loaders, standalone)
```

Hard invariants:

1. **Evidence unit**: link, platform, published date, quote + offset, signal class,
   first-hand flag, what it supports, what it does **not** prove. A quote that is not in the
   stored snapshot is rejected by `src/lib/evidence/quote-gate.ts`.
2. **Five signal classes** stay separate: problem → seeking → paying → switching →
   recurring. Never merge them into "demand".
3. **Scoring is code, not the model**: the 100-point rubric and the A–D credibility grade
   live in `src/lib/scoring/`; a report may not invent a score.
4. **Report claims are whitelisted**: every `evidenceIds` entry must belong to the same
   run. Uncited claims are moved to `unknowns`, never rendered as conclusions.
5. **Stage events do not end a run.** Only `runs.status` (`finished` / `failed` /
   `cancelled`) closes the SSE stream; `stage.started` / `stage.finished` are progress.

## Key Directories

| Path                                              | Purpose                                                                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/`                                        | Routes only: layouts, pages, route handlers. `(workbench)` is the app shell.                                                                                               |
| `src/app/(workbench)/threads/`                    | `/threads/new` and `/threads/[threadId]?view=…`; the conversation is the navigation unit.                                                                                  |
| `src/app/(workbench)/runs/`                       | `/runs` index plus `/runs/[runId]/{,report,evidence,plan}` — same panels as the thread tabs, reachable by URL.                                                             |
| `src/features/`                                   | Business components + server actions, one folder per domain (`chat`, `threads`, `runs`, `report`, `evidence`, `validation`, `settings`); features never import each other. |
| `src/components/ui/`                              | Token-only primitives (Button/Card/Sheet/Dialog/…); no business copy.                                                                                                      |
| `src/components/shell/`, `src/components/common/` | App chrome, nav, shared semantic badges.                                                                                                                                   |
| `src/lib/chat/`                                   | Chat model resolution and tool definitions.                                                                                                                                |
| `src/lib/crawl/`                                  | Static/Playwright fetch, robots, login profiles, extraction.                                                                                                               |
| `src/lib/crypto/`                                 | AES-256-GCM provider-key encryption.                                                                                                                                       |
| `src/lib/db/`                                     | Drizzle client, `.env` loader, migration runner, `schema/`.                                                                                                                |
| `src/lib/eval/`                                   | Extraction metrics (recall/precision) used by `scripts/eval-extract.ts`.                                                                                                   |
| `src/lib/evidence/`                               | Evidence schemas, quote gate, canonical URLs, snapshots, queries.                                                                                                          |
| `src/lib/hooks/`                                  | Shared React hooks.                                                                                                                                                        |
| `src/lib/llm/`                                    | Provider/model/chain repositories, adapters (openai-compatible, ollama, anthropic, google), quotas.                                                                        |
| `src/lib/pipeline/`                               | S1–S6 stages, run orchestration, stage context.                                                                                                                            |
| `src/lib/quota/`                                  | Per-provider request/allowance guards.                                                                                                                                     |
| `src/lib/report/`                                 | Report assembly, citation validation, persistence, read model, Markdown export.                                                                                            |
| `src/lib/runs/`                                   | Run/thread/event repository, queue producer, SSE helpers, stage vocabulary.                                                                                                |
| `src/lib/scoring/`                                | Rubric dimensions, aggregation, credibility grade, five-way decision.                                                                                                      |
| `src/lib/search/`                                 | Search adapters (DDG, Bing, HN, GitHub, App Store).                                                                                                                        |
| `src/lib/settings/`                               | Operator settings stored in the database.                                                                                                                                  |
| `src/lib/testing/`                                | Deterministic stub LLM and acceptance summary used by `scripts/acceptance.ts`.                                                                                             |
| `src/lib/validation/`                             | 14-day validation-plan repository and template.                                                                                                                            |
| `src/worker/main.ts`                              | pg-boss consumer that executes the pipeline.                                                                                                                               |
| `scripts/`                                        | `acceptance.ts`, `eval-extract.ts`, `crawl-login.ts`, `check-tokens.mjs`, `stub-provider.mjs`.                                                                             |
| `tests/e2e/`                                      | Playwright specs and DB/seed helpers.                                                                                                                                      |
| `tests/fixtures/`                                 | Crawl, extract-label and search fixtures.                                                                                                                                  |
| `drizzle/`                                        | Generated SQL migrations. Never edit by hand; change schema + `pnpm db:generate`.                                                                                          |
| `docs/`                                           | `runbook.md`, `acceptance.md`, `eval.md`, `superpowers/specs/`, `superpowers/plans/`, `design/`.                                                                           |
| `.worktrees/`                                     | Git-ignored isolated worktrees.                                                                                                                                            |

## Development Commands

```bash
cp .env.example .env        # DATABASE_URL points at 127.0.0.1:5433
docker compose up -d        # Postgres 16 (5432 is commonly taken, hence 5433)
pnpm install
pnpm db:generate            # schema -> drizzle/*.sql
pnpm db:migrate             # apply migrations (idempotent)
pnpm dev                    # http://127.0.0.1:3000
pnpm worker                 # pg-boss consumer for pipeline/s1
pnpm verify                 # typecheck + lint + vitest, must stay green
pnpm test                   # vitest (unit-node + unit-dom)
pnpm e2e                    # Playwright; starts dev server + stub provider
pnpm acceptance             # S2–S6 contract check with a deterministic stub model
pnpm eval:extract --dry     # label-set self-check + metric logic (no DB/model)
pnpm crawl:login <platform> # seed a browser profile for logged-in crawling
pnpm tokens:check           # fails on hard-coded colours outside globals.css
```

Full prerequisites, provider setup (Ollama / OpenCode Go / any OpenAI-compatible endpoint),
common failures and expected exit codes: `docs/runbook.md`.

Database-backed unit tests need a separate `_test` database and are skipped otherwise:

```bash
docker compose exec db psql -U demandx -d demandx -c 'CREATE DATABASE demandx_test'
DATABASE_URL=postgres://demandx:demandx@127.0.0.1:5433/demandx_test pnpm db:migrate
TEST_DATABASE_URL=postgres://demandx:demandx@127.0.0.1:5433/demandx_test pnpm test
```

## Code Conventions & Common Patterns

Enforced by tooling (see `eslint.config.mjs`, `scripts/check-tokens.mjs`):

- **Colours only via semantic tokens** (`bg-surface`, `text-fg`, `border-border`, `bg-accent`, `text-success`, `text-on-accent`). No hex/rgb/hsl in `src`, no `dark:` prefixes — dark mode swaps the `[data-theme='dark']` variable set.
- **Dependency direction**: `app → features/components → components/ui → lib`. Features must not import each other; `eslint-plugin-boundaries` blocks it.
- **Hooks live in `src/lib/hooks/`** and are tested with `renderHook`; components stay declarative.
- **External input is parsed with zod** before it reaches typed code; fallible operations return a discriminated `Result` rather than throwing across layers.
- **Server Components by default**; `'use client'` only for stateful islands (palette, tables, forms, charts).
- **No global state library.** Reads go through RSC + Drizzle, mutations through Server Actions, live progress through SSE with `after_seq` resume.
- **No new dependencies** without a concrete need; prefer the existing adapters and utilities.

Research-output rules that also constrain UI copy and fixtures:

- **Never fabricate results.** No placeholder runs, scores, evidence, posts or prices in
  pages or seed data. Empty state means empty; a missing report says why and links to
  evidence instead of rendering an estimated conclusion.
- **Every score cites evidence.** Scores are read back from `scores`, never recomputed in
  the render path; a report claim may only reference evidence ids from the same run.
- **Preserve fact / inference / unknown.** Missing data is `未知`, not an estimate.
- **Separate signals and negative evidence.** Discussion volume ≠ demand; demand ≠
  willingness to pay; include why users do _not_ buy.
- **Nightly/old runs are read-only.** Pages query the database per request
  (`export const dynamic = 'force-dynamic'`); no build-time snapshot of mutable data.

Documentation conventions:

- **User-visible behaviour or UX changes** must update `docs/runbook.md` in the same
  commit (what changed, how to use it, failure modes). Internal refactors, tests or
  style-only tweaks do not need docs.
- **Every screenshot added to `docs/design/` must be listed in
  `docs/design/README.md`** with one line saying what it shows; do not commit orphan
  captures.
- If a change alters a documented command, env var or chain/profile behaviour, fix the
  relevant table row instead of adding a second explanation elsewhere.

Operational conventions:

- **Migrations**: change `src/lib/db/schema/*`, run `pnpm db:generate`, apply to the
  development database first, then to `demandx_test`. Never hand-edit generated SQL.
- **Reports and evidence survive deletion of their originals** where the schema says so
  (`citations.evidence_id` is historical, `runs.thread_id` is `SET NULL`); do not add
  cascades that would erase an audit trail.
- **Provider keys** are encrypted at rest and masked in the UI; never log plaintext keys,
  `.env`, or full request payloads.
- **The worker owns `runs.status`.** Pages and client code must not flip a run to a terminal
  state on a stage event alone.

## Important Files

| File                                                      | Role                                                                                                                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                                               | Product spec: prompt, methodology, rubrics, report format. Only the `## 开发运行` section at the top is developer-facing; keep the spec body intact. |
| `docs/runbook.md`                                         | How to run everything from zero, provider setup, common errors, acceptance commands.                                                                 |
| `docs/acceptance.md`                                      | What `scripts/acceptance.ts` proves (contract) and what it does not (quality).                                                                       |
| `docs/eval.md`                                            | Extraction-eval scope, measured results and gaps.                                                                                                    |
| `docs/superpowers/specs/2026-10-29-demandx-design.md`     | Architecture, data model, pipeline DAG, scoring rules, crawler design.                                                                               |
| `docs/superpowers/specs/2026-10-29-demandx-ui-design.md`  | Route inventory, per-page stack, tokens, perf budgets.                                                                                               |
| `docs/superpowers/plans/2026-10-29-demandx-build-plan.md` | Task-by-task build plan P0–P7 and enforced engineering rules.                                                                                        |
| `docs/design/prototype/`                                  | Interactive high-fidelity prototype (`index.html`).                                                                                                  |

## Testing & QA

- **Unit**: `pnpm test` (vitest projects `unit-node` + `unit-dom`).
- **Database integration**: only with `TEST_DATABASE_URL` whose database name ends in
  `_test`; suites TRUNCATE their tables, so never point this at `demandx`.
- **E2E**: `pnpm e2e` (Playwright, 11 tests) drives the real UI against the shared
  `demandx` database and cleans up the rows it seeds.
- **Contract**: `pnpm acceptance` runs S2–S6 with a deterministic stub LLM; it proves the
  stages agree with each other, not that a real model extracts well.
- **Quality**: `pnpm eval:extract` (real `bulk` chain, exit code 2 when no provider is
  configured) and `--dry` (metric logic only). "Not measured" is never reported as a score.
- Before claiming completion, run `pnpm verify` (plus `pnpm e2e` when UI/routes changed)
  and report the observed exit codes. Do not claim a command ran when it did not.

## Working Agreements for AI Assistants

1. **Read `docs/runbook.md` first** when asked to run, debug startup, or configure a
   provider; it records the commands that actually work on this machine.
2. **Ground claims in code.** When describing behaviour, cite the file and the path that
   implements it; do not present planned work as implemented.
3. **State present vs planned.** Specs under `docs/superpowers/specs/` may be ahead of the
   code; check the source before repeating them.
4. **Do not add scaffolding** (empty dirs, stub manifests, placeholder pages) to make the
   repo look complete. Ship a working slice or state the blocker.
5. **Keep docs in sync with code** in the same change: routes, commands, env vars and
   acceptance numbers. `docs/runbook.md`, this file and `README.md` are the entry points.
6. **Never write secrets** (API keys, `.env` contents) into code, tests, logs or docs.
7. **Commit style**: terse, scoped (`feat(runs): …`, `docs: runbook and final navigation fixes`).

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
