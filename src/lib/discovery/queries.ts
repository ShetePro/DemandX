/**
 * A pool, not a fixed list: people phrase the same need in many ways, and two
 * scans that issued identical queries would return identical snippets (and so
 * identical ideas). Each scan samples a slice of the pool, so "再扫一轮"
 * actually looks somewhere else.
 *
 * Domestic phrases are Chinese; overseas ones lean on the sentence shapes that
 * forum posts actually use ("I wish there was", "anyone know a tool").
 */
export const DISCOVERY_QUERY_POOL: readonly string[] = [
  '有没有 推荐 工具 太麻烦',
  '为什么 没有 一个 软件 解决',
  '每天 手工 表格 太麻烦 吐槽',
  '求推荐 好用 工具 付费',
  '太难用了 想换 一个 工具',
  '有没有 替代 的 工具',
  '谁能 做个 这样 的 小程序',
  '这个 需求 有人 做 吗',
  '找了 一圈 没有 合适 的 工具',
  '每次 都要 手动 复制 粘贴 崩溃',
  '这个 痛点 有没有 人 解决',
  '想找 一个 能 自动 的 工具',
  '"I wish there was" app tool reddit',
  '"is there a tool" site:twitter.com',
  '"why is there no" app',
  '"looking for a tool to" reddit',
  '"anyone know a tool" reddit',
  '"I hate that I have to" manual',
  '"shut up and take my money" tool',
  '"alternative to" app site:reddit.com',
  '"recommend an app for" reddit',
  '"does anyone else" manually site:reddit.com',
  '"there should be an app"',
  '"I would pay for" tool',
  '"manual work" spreadsheet frustration',
  '"no good tool" site:news.ycombinator.com',
];

/** Queries per scan; enough breadth without spending the whole pool at once. */
export const DISCOVERY_QUERIES_PER_SCAN = 10;

/** S1-style cap per query; discovery values breadth over depth. */
export const DISCOVERY_HITS_PER_QUERY = 5;

/**
 * Sample `count` distinct queries. Random by default so a rescan differs; the
 * sampler is injected so tests stay deterministic.
 */
export function pickDiscoveryQueries(
  count = DISCOVERY_QUERIES_PER_SCAN,
  random: () => number = Math.random,
): string[] {
  const pool = [...DISCOVERY_QUERY_POOL];
  const take = Math.min(Math.max(1, count), pool.length);

  // Fisher–Yates: every query is equally likely, no repeats within a scan.
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const current = pool[index];
    const other = pool[swap];
    if (current === undefined || other === undefined) continue;
    pool[index] = other;
    pool[swap] = current;
  }
  return pool.slice(0, take);
}
