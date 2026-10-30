/**
 * The report as a Markdown document, built without a third-party generator so
 * the export is exactly what the page shows: the same eight parts, the same
 * citation anchors and the same unknowns.
 *
 * Two invariants of the report survive the conversion: a claim without a
 * citation never enters the body (S6 already refuses one, but the exporter must
 * not be the place where an uncited assertion becomes printable), and an
 * unknown is listed once even when two sections repeat it.
 */

import { DIMENSION_LABELS, SECTION_META } from '@/lib/report/sections';
import { REPORT_SECTIONS, type ReportSectionBody } from '@/lib/report/validate';
import { LIMITS, type DimensionScore } from '@/lib/scoring/types';
import { formatDate } from '@/lib/utils/format';

export interface MarkdownIdea {
  title: string;
}

export interface MarkdownReport {
  runId: number;
  sections: Record<string, ReportSectionBody>;
  /** Headline total from `reports.rubric_total`, 0–100. */
  rubricTotal: number;
  /** A–D, passed through as stored. */
  grade: string;
  /** The stored decision sentence, passed through as stored. */
  decision: string;
  createdAt: Date;
}

/** What a footnote needs; the exporter never reads the snapshot itself. */
export interface MarkdownEvidence {
  platform: string;
  publishedAt: Date | null;
  sourceUrl: string;
  supports: string | null;
  doesNotProve: string | null;
}

export interface MarkdownInput {
  idea: MarkdownIdea;
  report: MarkdownReport;
  scores: readonly DimensionScore[];
  evidenceMap: Readonly<Record<number, MarkdownEvidence>>;
}

/**
 * Escape the characters that would otherwise change the structure of a line:
 * a table cell breaks on `|`, emphasis markers and brackets start markup.
 * Newlines collapse to spaces so one claim stays one bullet.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, ' ')
    .replace(/([*_`|[\]])/g, '\\$1');
}

function points(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value)) : '0';
}

/**
 * Every `[eN]` the body actually renders, in first-appearance order. Feeding
 * the footnote list from this set is what keeps it free of evidence the report
 * mentions nowhere.
 */
function citedIds(sections: Record<string, ReportSectionBody>): number[] {
  const seen = new Set<number>();
  const order: number[] = [];

  for (const section of REPORT_SECTIONS) {
    for (const claim of sections[section]?.claims ?? []) {
      if (claim.evidenceIds.length === 0) continue;
      for (const id of claim.evidenceIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        order.push(id);
      }
    }
  }

  return order;
}

function scoreTable(scores: readonly DimensionScore[]): string[] {
  const lines = ['## 评分', '', '| 维度 | 得分 | 满分 | 依据 |', '| --- | ---: | ---: | --- |'];

  if (scores.length === 0) {
    lines.push('| — | 0 | 100 | 本轮没有可用的维度评分 |');
    return lines;
  }

  for (const score of scores) {
    lines.push(
      `| ${DIMENSION_LABELS[score.dimension]} | ${points(score.points)} | ${points(
        LIMITS[score.dimension],
      )} | ${escapeMarkdown(score.rationale || '—')} |`,
    );
  }

  return lines;
}

function footnoteList(
  ids: readonly number[],
  evidenceMap: Readonly<Record<number, MarkdownEvidence>>,
): string[] {
  if (ids.length === 0) return [];

  const lines = ['## 引用', ''];

  for (const id of ids) {
    const item = evidenceMap[id];
    if (item === undefined) {
      lines.push(`- [e${id}] 证据不可用（记录已被删除）`);
      continue;
    }

    const date = item.publishedAt === null ? '日期未知' : formatDate(item.publishedAt);
    lines.push(`- [e${id}] ${escapeMarkdown(item.platform)} · ${date} · ${item.sourceUrl}`);

    const supports = item.supports?.trim() ?? '';
    if (supports !== '') lines.push(`  - 支持：${escapeMarkdown(supports)}`);

    const notProves = item.doesNotProve?.trim() ?? '';
    if (notProves !== '') lines.push(`  - 不能证明：${escapeMarkdown(notProves)}`);
  }

  return lines;
}

/** One section, with its cited claims and the unknowns not yet printed. */
function sectionLines(
  section: (typeof REPORT_SECTIONS)[number],
  body: ReportSectionBody | undefined,
  seenUnknowns: Set<string>,
): string[] {
  const meta = SECTION_META[section];
  const lines = [`## ${meta.ordinal}、${meta.label}`, ''];

  const cited = (body?.claims ?? []).filter((claim) => claim.evidenceIds.length > 0);
  if (cited.length === 0) {
    lines.push('（本节没有带引用的论断）', '');
  } else {
    for (const claim of cited) {
      const markers = claim.evidenceIds.map((id) => `[e${id}]`).join('');
      lines.push(`- ${escapeMarkdown(claim.text)} ${markers}`);
    }
    lines.push('');
  }

  const fresh = (body?.unknowns ?? []).filter((unknown) => {
    const key = unknown.trim();
    if (key === '' || seenUnknowns.has(key)) return false;
    seenUnknowns.add(key);
    return true;
  });

  if (fresh.length > 0) {
    lines.push('**本节未知项**', '');
    for (const unknown of fresh) lines.push(`- ${escapeMarkdown(unknown)}`);
    lines.push('');
  }

  return lines;
}

export function toMarkdown({ idea, report, scores, evidenceMap }: MarkdownInput): string {
  const title = idea.title.trim() === '' ? '未命名研究' : idea.title.trim();
  const lines = [
    `# ${escapeMarkdown(title)}`,
    '',
    `**决策**：${escapeMarkdown(report.decision)}`,
    '',
    `**总分**：${points(report.rubricTotal)} / 100`,
    '',
    `**可信度**：${escapeMarkdown(report.grade)}`,
    '',
    `_报告生成于 ${formatDate(report.createdAt)} · run #${report.runId}_`,
    '',
    ...scoreTable(scores),
    '',
  ];

  const seenUnknowns = new Set<string>();
  for (const section of REPORT_SECTIONS) {
    lines.push(...sectionLines(section, report.sections[section], seenUnknowns));
  }

  lines.push(...footnoteList(citedIds(report.sections), evidenceMap));

  // One trailing newline, no blank run at the end.
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

/** A filesystem-safe name: `<idea>-<date>.md`, with a stable fallback. */
export function reportMarkdownFilename(report: MarkdownReport, idea: MarkdownIdea): string {
  const slug = idea.title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 48)
    .replace(/^-+|-+$/g, '');

  return `${slug === '' ? `demandx-run-${report.runId}` : slug}-${formatDate(report.createdAt)}.md`;
}
