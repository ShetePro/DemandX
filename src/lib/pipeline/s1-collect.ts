import type { CrawlPort } from '@/lib/crawl/port';
import { canonicalizeUrl } from '@/lib/evidence/canonical-url';
import { hammingDistance, simhash64 } from '@/lib/evidence/simhash';
import { writeSnapshot } from '@/lib/evidence/snapshot';
import { assertAlive } from '@/lib/quota/deadline';
import { ok, type Result } from '@/lib/quota/types';
import type { SearchHit, SearchPort } from '@/lib/search/port';
import type { InsertSourceInput, RecordQueryInput } from '@/lib/runs/sources-repository';

import { buildAngles, type AngleGroup } from './angles';
import type { RunContext } from './context';

/** Matches the build plan's "5 hits per query" cap. */
const SEARCH_LIMIT = 5;

/** Two pages this close are the same content republished; keep the first. */
export const SIMHASH_DUPLICATE_THRESHOLD = 3;

export interface S1Summary {
  /** Rows newly inserted by this run. */
  sources: number;
  /** URLs that were never fetched (quota, robots) or failed. */
  skipped: number;
  /** Pages behind a login wall or captcha; queued for a person, never retried here. */
  needsHuman: number;
}

export interface CollectDeps {
  searchPorts: readonly SearchPort[];
  crawl: CrawlPort;
  /** One claim per search call; a refused claim skips that port, not the run. */
  quota: { claim(source: string): Promise<Result<unknown>> };
  repo: {
    insertSource(input: InsertSourceInput): Promise<Result<{ id: number; inserted: boolean }>>;
    listSourceUrls(runId: number): Promise<Result<string[]>>;
  };
  /** Optional audit log; its failure never fails the run. */
  recordQuery?: (input: RecordQueryInput) => Promise<Result<unknown>>;
  /** Defaults to `SNAPSHOT_DIR` (then `./data/snapshots`) via `writeSnapshot`. */
  snapshotDir?: string;
  onEvent?: (type: string, payload: Record<string, unknown>) => Promise<void>;
  now?: () => Date;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Collection telemetry must never abort collection: a run that already fetched
 * pages keeps them even if writing the event fails.
 */
async function emit(
  deps: Pick<CollectDeps, 'onEvent'>,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.onEvent?.(type, payload);
  } catch {
    // Intentionally swallowed: the source insert is the durable record.
  }
}

/**
 * `ctx.angles` is S0's decision; S1 rebuilds the same groups from the idea with
 * templates, so the list only filters. An unknown set (older runs stored user
 * text) falls back to every group rather than silently collecting nothing.
 */
function selectGroups(ctx: RunContext): AngleGroup[] {
  const all = buildAngles(ctx.idea);
  if (ctx.angles.length === 0) return all;

  const wanted = new Set(ctx.angles);
  const selected = all.filter((group) => wanted.has(group.angle));
  return selected.length > 0 ? selected : all;
}

/**
 * S1: angles → queries → search → dedupe → crawl → snapshot → `sources`, one
 * event per outcome and a progress event after every query. No LLM, no
 * concurrency pool: the search adapters' limiter and the crawler already pace
 * the external calls, and serial execution keeps quota accounting honest.
 */
export async function collectS1(ctx: RunContext, deps: CollectDeps): Promise<Result<S1Summary>> {
  const now = deps.now ?? (() => new Date());

  // Stage entrance check, before any external call.
  const alive = assertAlive(ctx.deadlineAt, now());
  if (!alive.ok) return alive;

  const groups = selectGroups(ctx);
  const total = groups.reduce((sum, group) => sum + group.queries.length, 0);
  if (total === 0) return ok({ sources: 0, skipped: 0, needsHuman: 0 });

  const seeded = await deps.repo.listSourceUrls(ctx.runId);
  if (!seeded.ok) return seeded;

  const seen = new Set(seeded.value);
  /** Fingerprints of snapshots stored by this run, for near-duplicate detection. */
  const fingerprints: bigint[] = [];

  let sources = 0;
  let skipped = 0;
  let needsHuman = 0;
  let done = 0;

  for (const group of groups) {
    for (const query of group.queries) {
      const aliveHere = assertAlive(ctx.deadlineAt, now());
      if (!aliveHere.ok) return aliveHere;

      for (const port of deps.searchPorts) {
        const claimed = await deps.quota.claim(port.id);
        if (!claimed.ok) {
          skipped += 1;
          continue;
        }

        let hits: SearchHit[];
        try {
          hits = await port.search(query, { limit: SEARCH_LIMIT });
        } catch (error) {
          skipped += 1;
          await emit(deps, 'query.failed', {
            stage: 'S1',
            angle: group.angle,
            query,
            provider: port.id,
            message: messageOf(error),
          });
          continue;
        }

        if (deps.recordQuery) {
          const recorded = await deps.recordQuery({
            runId: ctx.runId,
            angle: group.angle,
            provider: port.id,
            text: query,
            resultCount: hits.length,
          });
          // The query table is an audit trail; losing an entry never loses a source.
          if (!recorded.ok) {
            await emit(deps, 'query.unrecorded', { provider: port.id, query });
          }
        }

        for (const hit of hits) {
          const canonical = canonicalizeUrl(hit.url);
          if (canonical === null) {
            skipped += 1;
            await emit(deps, 'source.skipped', {
              stage: 'S1',
              url: hit.url,
              reason: 'invalid_url',
            });
            continue;
          }
          // Already stored by this run (or a previous attempt of it): no re-fetch.
          if (seen.has(canonical)) continue;

          const aliveHit = assertAlive(ctx.deadlineAt, now());
          if (!aliveHit.ok) return aliveHit;

          let crawled;
          try {
            crawled = await deps.crawl.crawl(hit.url);
          } catch (error) {
            skipped += 1;
            await emit(deps, 'source.failed', {
              stage: 'S1',
              url: canonical,
              code: 'CRAWL_ERROR',
              message: messageOf(error),
            });
            continue;
          }

          if (crawled.status === 'needs_human') {
            needsHuman += 1;
            // Queued for a person: re-fetching it for the next query in this run
            // would only re-detect the same wall.
            seen.add(canonical);
            await emit(deps, 'source.needs_human', {
              stage: 'S1',
              url: canonical,
              platform: hit.platform,
              reason: crawled.reason,
            });
            continue;
          }

          if (crawled.status === 'skipped') {
            skipped += 1;
            // A policy skip is terminal by definition; never fetch it again here.
            seen.add(canonical);
            await emit(deps, 'source.skipped', {
              stage: 'S1',
              url: canonical,
              platform: hit.platform,
              reason: crawled.reason,
            });
            continue;
          }

          if (crawled.status === 'error') {
            skipped += 1;
            await emit(deps, 'source.failed', {
              stage: 'S1',
              url: canonical,
              platform: hit.platform,
              code: crawled.code,
            });
            continue;
          }

          const { snapshot } = crawled;
          const fingerprint = simhash64(snapshot.text);
          if (
            fingerprints.some(
              (stored) => hammingDistance(stored, fingerprint) <= SIMHASH_DUPLICATE_THRESHOLD,
            )
          ) {
            skipped += 1;
            seen.add(canonical);
            await emit(deps, 'source.skipped', {
              stage: 'S1',
              url: canonical,
              platform: hit.platform,
              reason: 'near_duplicate',
            });
            continue;
          }

          let written;
          try {
            written = await writeSnapshot({
              text: snapshot.text,
              html: snapshot.html,
              url: canonical,
              ...(deps.snapshotDir === undefined ? {} : { dir: deps.snapshotDir }),
            });
          } catch (error) {
            skipped += 1;
            await emit(deps, 'source.failed', {
              stage: 'S1',
              url: canonical,
              code: 'SNAPSHOT_FAILED',
              message: messageOf(error),
            });
            continue;
          }

          const inserted = await deps.repo.insertSource({
            runId: ctx.runId,
            canonicalUrl: canonical,
            platform: hit.platform,
            contentHash: written.hash,
            snapshotPath: written.textPath,
            crawlTier: crawled.settled === undefined ? 'static' : 'browser',
            fetchedAt: now(),
          });
          // A storage failure is not one bad source: nothing after it can be trusted.
          if (!inserted.ok) return inserted;

          seen.add(canonical);
          fingerprints.push(fingerprint);
          if (inserted.value.inserted) sources += 1;

          await emit(deps, 'source.added', {
            stage: 'S1',
            url: canonical,
            platform: hit.platform,
            title: hit.title,
            sourceId: inserted.value.id,
            snapshotHash: written.hash,
            duplicate: !inserted.value.inserted,
          });
        }
      }

      done += 1;
      await emit(deps, 'stage.progress', { stage: 'S1', done, total, sources });
    }
  }

  return ok({ sources, skipped, needsHuman });
}
