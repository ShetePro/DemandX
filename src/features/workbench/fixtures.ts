/**
 * Placeholder workbench data until runs are read from the database (T2/T6).
 *
 * Field names mirror `runs`/`analyses` so the swap to a query changes the data
 * source, not the view. `updatedAt` is derived from the time the server bundle
 * loads, which keeps the relative labels ("2 分钟前") honest on a fresh boot.
 */

export type RunStatus = 'running' | 'completed' | 'abandoned' | 'partial';

export type RunDecision = 'validate-first' | 'abandon' | 'insufficient';

export type RunGrade = 'A' | 'B' | 'C' | 'D';

export interface WorkbenchRun {
  title: string;
  status: RunStatus;
  /** Final decision once a run finishes; `null` while it is still running. */
  decision: RunDecision | null;
  /** 0–100 rubric total; `null` until the scoring stage completes. */
  score: number | null;
  /** Evidence-credibility grade, independent of `score`. */
  grade: RunGrade | null;
  updatedAt: Date;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const BOOTED_AT = new Date();

export const WORKBENCH_FIXTURES: readonly WorkbenchRun[] = [
  {
    title: '跨境卖家多平台库存同步',
    status: 'running',
    decision: null,
    score: null,
    grade: null,
    updatedAt: new Date(BOOTED_AT.getTime() - 2 * MINUTE),
  },
  {
    title: '独立开发者发票与报销',
    status: 'completed',
    decision: 'validate-first',
    score: 71,
    grade: 'B',
    updatedAt: new Date(BOOTED_AT.getTime() - DAY),
  },
  {
    title: '宠物健康订阅盒',
    status: 'abandoned',
    decision: 'abandon',
    score: 34,
    grade: 'D',
    updatedAt: new Date(BOOTED_AT.getTime() - 3 * DAY),
  },
  {
    title: '小红书选题与竞品监控',
    status: 'partial',
    decision: 'insufficient',
    score: 52,
    grade: 'C',
    updatedAt: new Date(BOOTED_AT.getTime() - 5 * DAY),
  },
];
