import { cn } from '@/lib/utils/cn';

/** The five demand signals, graded separately and never merged. */
export type Signal = 'problem' | 'seeking' | 'paying' | 'switching' | 'recurring';

interface SignalMeta {
  label: string;
  ariaLabel: string;
  tone: string;
}

/** Colors follow UI design §12: same signal, same token, on every page. */
const SIGNAL_META: Record<Signal, SignalMeta> = {
  problem: {
    label: '问题',
    ariaLabel: '信号：问题存在',
    tone: 'border-accent/40 bg-accent-soft text-accent',
  },
  seeking: {
    label: '寻找',
    ariaLabel: '信号：主动寻找',
    tone: 'border-s2/40 bg-s2/10 text-s2',
  },
  paying: {
    label: '付费',
    ariaLabel: '信号：已付费',
    tone: 'border-success/40 bg-success-soft text-success',
  },
  switching: {
    label: '切换',
    ariaLabel: '信号：愿意切换',
    tone: 'border-warning/40 bg-warning-soft text-warning',
  },
  recurring: {
    label: '持续',
    ariaLabel: '信号：持续付费',
    tone: 'border-s4/40 bg-s4/10 text-s4',
  },
};

export interface SignalBadgeProps {
  signal: Signal;
  className?: string;
}

export function SignalBadge({ signal, className }: SignalBadgeProps) {
  const meta = SIGNAL_META[signal];

  return (
    <span
      role="img"
      aria-label={meta.ariaLabel}
      className={cn(
        'inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[11px] leading-none font-semibold whitespace-nowrap',
        meta.tone,
        className,
      )}
    >
      {meta.label}
    </span>
  );
}
