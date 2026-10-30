import { Badge } from '@/components/ui/badge';
import { STATUS_META } from '@/lib/runs/stages';

/**
 * One status pill for every run list. The label and tone come from the shared
 * stage vocabulary so the workbench, the `/runs` index and the monitor page
 * cannot disagree; an unknown database value is shown verbatim instead of
 * being guessed.
 */
export function RunStatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status as keyof typeof STATUS_META];
  const live = status === 'running';

  return (
    <Badge tone={meta?.tone ?? 'neutral'}>
      {live ? (
        <span aria-hidden="true" className="mr-1.5 inline-block size-1.5 rounded-full bg-current" />
      ) : null}
      {meta?.label ?? status}
    </Badge>
  );
}
