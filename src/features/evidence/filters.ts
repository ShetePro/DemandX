import { SIGNALS, type Signal } from '@/lib/evidence/schema';

import type { EvidenceFilterState } from './types';

/** `searchParams` values are `string | string[] | undefined`; take the first. */
function firstValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Parse the evidence URL filters. Anything unknown, blank or over the size cap
 * is ignored rather than forwarded to the query, so a hand-edited URL can only
 * ever select a valid signal/status and a bounded search string.
 */
export function parseEvidenceFilters(
  raw: Record<string, string | string[] | undefined>,
): EvidenceFilterState {
  const signal = firstValue(raw.signal);
  const platform = firstValue(raw.platform);
  const status = firstValue(raw.status);
  const q = firstValue(raw.q);

  return {
    signal:
      signal !== null && (SIGNALS as readonly string[]).includes(signal)
        ? (signal as Signal)
        : null,
    platform: platform !== null && platform.length <= 60 ? platform : null,
    status: status === 'accepted' || status === 'rejected' ? status : null,
    q: q !== null && q.length <= 100 ? q : null,
  };
}
