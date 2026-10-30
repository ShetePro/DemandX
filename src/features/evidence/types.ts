import type {
  EvidenceCounts,
  EvidenceListItem,
  EvidenceStatusFilter,
} from '@/lib/evidence/queries';
import type { QuoteHighlight } from '@/lib/evidence/highlight';
import type { Signal } from '@/lib/evidence/schema';

/** A DB row plus the server-cut fragments; the full snapshot never reaches the client. */
export interface EvidenceViewItem extends EvidenceListItem {
  /** `null` when the row is rejected, has no offset, or its snapshot is missing. */
  highlight: QuoteHighlight | null;
}

export type { EvidenceCounts, EvidenceStatusFilter };

/** Filters parsed from `searchParams`; `null` means "all". */
export interface EvidenceFilterState {
  signal: Signal | null;
  platform: string | null;
  status: EvidenceStatusFilter | null;
  q: string | null;
}

/** Chinese labels for the reasons the store can hold. Unknown codes fall through. */
export const REJECTED_REASON_LABEL: Readonly<Record<string, string>> = {
  manual: '人工驳回',
  quote_not_in_snapshot: '引文不在快照中',
  empty_quote: '引文为空或超长',
};

export function rejectedReasonLabel(reason: string | null): string | null {
  if (reason === null || reason === '') return null;
  return REJECTED_REASON_LABEL[reason] ?? reason;
}
