/**
 * Discovery queries are deliberately bilingual and phrase-shaped: people who
 * have a real problem write "有没有…推荐" or "I wish there was…", not the
 * marketing keywords a keyword planner suggests. Two domestic and two overseas
 * phrasings per side keep the scan broad without spending an API quota on ten
 * near-identical queries.
 */
export const DISCOVERY_QUERIES: readonly string[] = [
  '有没有 推荐 工具 太麻烦',
  '为什么 没有 一个 软件 解决',
  '每天 手工 表格 太麻烦 吐槽',
  '求推荐 好用 工具 付费',
  '"I wish there was" app tool reddit',
  '"is there a tool" site:twitter.com',
  '"why is there no" app',
  '"looking for a tool to" reddit',
];

/** S1-style cap per query; discovery values breadth over depth. */
export const DISCOVERY_HITS_PER_QUERY = 3;
