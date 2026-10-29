import { cn } from '@/lib/utils/cn';

/** Evidence-credibility grade from the scoring rubric. */
export type Grade = 'A' | 'B' | 'C' | 'D';

/**
 * A–D maps to the shared semantic scale (UI design §12): A=success, B=--c1,
 * C=warning, D=danger. Same mapping on every page; never a second palette.
 */
const GRADE_TONES: Record<Grade, string> = {
  A: 'border-success/40 bg-success-soft text-success',
  B: 'border-s1/40 bg-s1/10 text-s1',
  C: 'border-warning/40 bg-warning-soft text-warning',
  D: 'border-danger/40 bg-danger-soft text-danger',
};

export interface GradeBadgeProps {
  grade: Grade;
  className?: string;
}

export function GradeBadge({ grade, className }: GradeBadgeProps) {
  return (
    <span
      role="img"
      aria-label={`可信度 ${grade}`}
      className={cn(
        'inline-grid size-5 shrink-0 place-items-center rounded-md border text-[11px] leading-none font-semibold',
        GRADE_TONES[grade],
        className,
      )}
    >
      {grade}
    </span>
  );
}
