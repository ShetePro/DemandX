'use client';

import { ChevronDown, Download, Printer } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { CitationChip } from '@/components/common/citation-chip';
import { GradeBadge, type Grade } from '@/components/common/grade-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import type { ReportEvidenceItem, ReportRecord } from '@/lib/report/read';
import { SECTION_META } from '@/lib/report/sections';
import { REPORT_SECTIONS, type ReportClaim, type ReportSection } from '@/lib/report/validate';
import type { DimensionScore } from '@/lib/scoring/types';
import { cn } from '@/lib/utils/cn';
import { formatDate, formatScore } from '@/lib/utils/format';

import { CitationPanel } from './citation-panel';
import { exportReportAction } from './export-action';

/**
 * The chart is the only reason the report needs recharts, so it is pulled in
 * after mount: the first screen (header, TOC, prose) stays small and the SVG
 * never renders on the server.
 */
const RadarChart = dynamic(() => import('./radar-chart').then((mod) => mod.RadarChart), {
  ssr: false,
  loading: () => <div aria-hidden className="h-[300px] animate-pulse rounded-lg bg-surface-2" />,
});

/** Matches Tailwind's `xl`; below it the citation rail becomes a Sheet. */
const WIDE_QUERY = '(min-width: 1280px)';

const GRADES: readonly string[] = ['A', 'B', 'C', 'D'];

function isGrade(value: string): value is Grade {
  return GRADES.includes(value);
}

const DECISION_TONES: Readonly<Record<string, 'success' | 'warning' | 'danger' | 'neutral'>> = {
  建议开发: 'success',
  '建议先验证，再开发': 'warning',
  建议调整定位: 'warning',
  建议暂缓: 'neutral',
  建议放弃: 'danger',
};

function firstCitedId(sections: ReportRecord['sections']): number | null {
  for (const section of REPORT_SECTIONS) {
    for (const claim of sections[section]?.claims ?? []) {
      if (claim.evidenceIds.length > 0) return claim.evidenceIds[0] ?? null;
    }
  }
  return null;
}

/** Every `[eN]` the body renders, once, in first-appearance order. */
function collectCitedIds(sections: ReportRecord['sections']): number[] {
  const seen = new Set<number>();
  const ids: number[] = [];

  for (const section of REPORT_SECTIONS) {
    for (const claim of sections[section]?.claims ?? []) {
      for (const id of claim.evidenceIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
    }
  }

  return ids;
}

/**
 * Explicit analysis, set apart from cited claims: the reader must be able to
 * tell an investor-style judgement from a fact with a source.
 */
function SectionInferences({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null;

  return (
    <div className="mt-4 rounded-xl border border-accent/30 bg-accent-soft/40 p-3">
      <p className="mb-1.5 text-xs font-semibold text-accent">
        资深从业者判断（推断，非事实）
      </p>
      <ul className="flex list-disc flex-col gap-1.5 pl-4 text-[13px] leading-6 text-fg/85">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function SectionUnknowns({
  items,
  defaultOpen = false,
}: {
  items: readonly string[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (items.length === 0) return null;

  return (
    <div className="mt-4 rounded-lg border border-dashed border-border-strong bg-surface-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="no-print flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-muted hover:text-fg"
      >
        <span>本节未知项 {items.length}</span>
        <ChevronDown
          aria-hidden
          className={cn('size-3.5 transition-transform', open && 'rotate-180')}
        />
      </button>
      <ul
        aria-hidden={!open}
        className={cn(
          'list-disc space-y-1 px-6 pt-1 pb-3 text-xs text-muted',
          // Print expands the block: paper cannot be clicked open, and an
          // omitted unknown would read as a complete answer.
          open ? 'block' : 'hidden print:block',
        )}
      >
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function Claim({ claim, onOpen }: { claim: ReportClaim; onOpen: (id: number) => void }) {
  return (
    <li className="border-b border-border pb-3 last:border-0 last:pb-0">
      <p className="text-sm leading-7 text-fg">
        <span className="break-words">{claim.text}</span>
        {claim.evidenceIds.map((id) => (
          <span key={id} className="whitespace-nowrap">
            <CitationChip id={`e${id}`} onOpen={() => onOpen(id)} className="print:hidden" />
            <span className="hidden print:inline">[e{id}]</span>
          </span>
        ))}
        {claim.evidenceIds.length === 0 ? (
          <span className="ml-1 inline-flex items-center rounded border border-border bg-surface-2 px-1 align-baseline text-[11px] font-medium text-muted">
            无引用
          </span>
        ) : null}
      </p>
    </li>
  );
}

export interface ReportViewProps {
  runId: number;
  ideaTitle: string;
  report: ReportRecord;
  scores: readonly DimensionScore[];
  /** Only cited evidence; absent ids stay absent so the panel can say so. */
  evidenceMap: Record<number, ReportEvidenceItem>;
}

/**
 * Report reader: table of contents, prose and the citation rail. It never
 * derives a number — `rubricTotal`, the grade and the decision come from the
 * stored report, and the score table plots `scores` as written by S4.
 */
export function ReportView({ runId, ideaTitle, report, scores, evidenceMap }: ReportViewProps) {
  const [active, setActive] = useState<ReportSection>('summary');
  const [selectedId, setSelectedId] = useState<number | null>(() => firstCitedId(report.sections));
  const [sheetOpen, setSheetOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const isWide = useMediaQuery(WIDE_QUERY);

  const total = formatScore(
    Math.min(100, Math.max(0, Number.isFinite(report.rubricTotal) ? report.rubricTotal : 0)),
  );
  const selected = selectedId === null ? null : (evidenceMap[selectedId] ?? null);
  const evidenceHref = `/runs/${runId}/evidence`;

  const cited = useMemo(() => collectCitedIds(report.sections), [report.sections]);

  // S6 refuses an uncited claim, so seeing one means the row was edited or the
  // validator gap is real. Say it in the console instead of failing to render.
  useEffect(() => {
    const uncited: string[] = [];
    for (const section of REPORT_SECTIONS) {
      for (const claim of report.sections[section]?.claims ?? []) {
        if (claim.evidenceIds.length === 0) uncited.push(`${section}: ${claim.text}`);
      }
    }
    if (uncited.length > 0) {
      console.warn(`报告中有 ${uncited.length} 条论断没有引用`, uncited);
    }
  }, [report.sections]);

  // Scrollspy. jsdom has no IntersectionObserver, so tests simply keep the
  // first section active instead of mounting a polyfill they do not test.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;

    const elements = REPORT_SECTIONS.map((section) => document.getElementById(section)).filter(
      (element): element is HTMLElement => element !== null,
    );
    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0];
        if (first) setActive(first.target.id as ReportSection);
      },
      { rootMargin: '-10% 0px -70% 0px' },
    );

    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function openCitation(id: number) {
    setSelectedId(id);
    setSheetOpen(true);
  }

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    try {
      const result = await exportReportAction(runId);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }

      const blob = new Blob([result.value.content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.value.filename;
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success('已导出 Markdown');
    } catch {
      toast.error('导出失败：网络错误');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] p-6">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
        <div className="min-w-0">
          <p className="text-xs text-muted">报告 · run #{runId}</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-fg">{ideaTitle}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone={DECISION_TONES[report.decision] ?? 'neutral'}>{report.decision}</Badge>
            <span className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs font-medium text-fg">
              {report.rubricTotal === 0 ? '未评分' : `${total} / 100`}
            </span>
            {isGrade(report.grade) ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                <GradeBadge grade={report.grade} />
                可信度 {report.grade}
              </span>
            ) : (
              <Badge tone="neutral">可信度 {report.grade}</Badge>
            )}
          </div>
        </div>

        <div className="no-print flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/runs/${runId}`}>运行监控</Link>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/runs/${runId}/plan`}>验证计划</Link>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => window.print()}>
            <Printer className="size-3.5" aria-hidden />
            打印
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleExport()}
            disabled={exporting}
          >
            <Download className="size-3.5" aria-hidden />
            {exporting ? '导出中…' : '导出 Markdown'}
          </Button>
        </div>
      </header>

      <div className="mt-5 grid grid-cols-1 gap-6 xl:grid-cols-[200px_minmax(0,1fr)_320px] xl:items-start">
        <nav
          aria-label="报告目录"
          className="no-print sticky top-0 z-10 -mx-6 border-b border-border bg-bg/90 px-6 py-2 backdrop-blur xl:top-6 xl:mx-0 xl:border-0 xl:bg-transparent xl:px-0 xl:py-0 xl:backdrop-blur-none"
        >
          <ol className="flex gap-1 overflow-x-auto xl:flex-col xl:gap-0.5 xl:overflow-visible">
            {REPORT_SECTIONS.map((section) => {
              const meta = SECTION_META[section];
              return (
                <li key={section}>
                  <a
                    href={`#${section}`}
                    aria-current={active === section ? 'true' : undefined}
                    className={cn(
                      'block rounded-md border-l-2 px-2.5 py-1.5 text-xs whitespace-nowrap transition-colors motion-reduce:transition-none',
                      active === section
                        ? 'border-accent bg-accent-soft font-semibold text-accent'
                        : 'border-transparent text-muted hover:bg-surface-2 hover:text-fg',
                    )}
                  >
                    {meta.ordinal} {meta.label}
                  </a>
                </li>
              );
            })}
          </ol>
        </nav>

        <article className="max-w-[760px] min-w-0">
          {REPORT_SECTIONS.map((section) => {
            const meta = SECTION_META[section];
            const body = report.sections[section];
            const claims = body?.claims ?? [];
            const unknowns = body?.unknowns ?? [];
            const inferences = body?.inferences ?? [];

            return (
              <section
                key={section}
                id={section}
                aria-labelledby={`${section}-title`}
                className="mb-9 scroll-mt-6"
              >
                <h2
                  id={`${section}-title`}
                  className="text-base font-semibold tracking-tight text-fg"
                >
                  {meta.ordinal}、{meta.label}
                </h2>

                {claims.length === 0 && inferences.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">本节暂无可引用的证据，下面是需要补齐的未知项。</p>
                ) : null}

                {claims.length === 0 ? null : (
                  <ul className="mt-3 space-y-3">
                    {claims.map((claim, index) => (
                      <Claim key={index} claim={claim} onOpen={openCitation} />
                    ))}
                  </ul>
                )}

                {section === 'summary' && scores.length > 0 ? (
                  <figure className="mt-4 rounded-xl border border-border bg-surface p-4">
                    <figcaption className="mb-1 flex items-center justify-between gap-2 text-xs font-semibold text-fg">
                      <span>七维评分</span>
                      <span className="font-normal text-muted">总分 {total} · 上限 100</span>
                    </figcaption>
                    <RadarChart scores={scores} />
                  </figure>
                ) : null}

                <SectionInferences items={inferences} />
                <SectionUnknowns
                  items={unknowns}
                  defaultOpen={claims.length === 0 && inferences.length === 0}
                />
              </section>
            );
          })}

          {cited.length > 0 ? (
            <section aria-label="引用脚注" className="mt-10 hidden print:block">
              <h2 className="text-base font-semibold text-fg">引用</h2>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted">
                {cited.map((id) => {
                  const item = evidenceMap[id];
                  return (
                    <li key={id}>
                      [e{id}]{' '}
                      {item === undefined
                        ? '证据不可用（记录已被删除）'
                        : `${item.platform} · ${
                            item.publishedAt === null ? '日期未知' : formatDate(item.publishedAt)
                          } · ${item.sourceUrl}`}
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}
        </article>

        <aside className="no-print hidden xl:block">
          <div className="sticky top-6">
            <CitationPanel
              citationId={selectedId}
              evidence={selected}
              evidenceHref={evidenceHref}
            />
          </div>
        </aside>
      </div>

      <Sheet
        open={sheetOpen && !isWide}
        onOpenChange={(open) => {
          if (!open) setSheetOpen(false);
        }}
      >
        <SheetContent className="no-print overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="sr-only">引用详情</SheetTitle>
            <SheetDescription className="sr-only">证据原文、快照片段与证明边界</SheetDescription>
          </SheetHeader>
          <CitationPanel citationId={selectedId} evidence={selected} evidenceHref={evidenceHref} />
        </SheetContent>
      </Sheet>
    </div>
  );
}
