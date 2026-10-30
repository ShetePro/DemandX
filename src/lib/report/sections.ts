/**
 * Presentation vocabulary of the stored report. The eight parts and the seven
 * rubric dimensions are fixed by spec §4.4/§9; naming them once keeps the page,
 * the print footnote list and the Markdown export from drifting apart.
 */

import type { Dimension } from '@/lib/scoring/types';

import type { ReportSection } from './validate';

export interface SectionMeta {
  /** Chinese heading, without the ordinal. */
  label: string;
  /** Ordinal prefix used by the table of contents and `##` headings. */
  ordinal: string;
}

export const SECTION_META: Record<ReportSection, SectionMeta> = {
  summary: { label: '执行摘要', ordinal: '一' },
  evidence: { label: '需求证据', ordinal: '二' },
  competitors: { label: '竞品调查', ordinal: '三' },
  ranking: { label: '机会排名', ordinal: '四' },
  bestDirection: { label: '最佳方向', ordinal: '五' },
  finance: { label: '财务模型', ordinal: '六' },
  plan: { label: '14 天验证计划', ordinal: '七' },
  decision: { label: '最终决策', ordinal: '八' },
};

export const DIMENSION_LABELS: Record<Dimension, string> = {
  needs: '真实需求',
  payment: '付费意愿',
  gap: '竞品缺口',
  acquisition: '获客可行性',
  profit: '收入与利润',
  feasibility: '技术可行性',
  longevity: '长期潜力',
};

/**
 * The heading the page and the export share. `ideas.title` is set from the
 * pitch's first line, but a thread opened before any pitch exists holds an
 * empty one, so the raw input is the fallback and never an empty `<h1>`.
 */
export function reportTitle(idea: { title: string; rawInput: string }): string {
  const title = idea.title.trim();
  if (title !== '') return title;

  const raw = idea.rawInput.replace(/\s+/g, ' ').trim();
  return raw === '' ? '未命名研究' : raw.slice(0, 40);
}
