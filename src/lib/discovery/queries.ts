/**
 * Vertical pain queries, not generic complaints. Each line names a concrete
 * workflow plus its buyer (财务/HR/卖家/门店…), which is what makes a result
 * both relevant and commercially meaningful; "太麻烦了" alone returns advice
 * columns and unrelated forum threads.
 *
 * Every scan samples a slice, so "再扫一轮" looks at a different set.
 */
export const DISCOVERY_QUERY_POOL: readonly string[] = [
  '发票 报销 手工 excel 小公司 财务',
  '对账 手工 excel 电商 财务 工具',
  '库存 同步 多平台 卖家 超卖',
  '客户 管理 excel 销售 小团队 跟进',
  '排班 excel 手工 门店 店长',
  '合同 审批 手工 小公司 用印',
  '简历 筛选 手工 hr 小公司 招聘',
  '报价单 手工 excel 小公司 销售',
  '采购 询价 excel 比价 小公司',
  '项目 工时 统计 excel 外包 团队',
  '账单 催收 手工 自由职业 收款',
  '数据 录入 手工 重复 小企业 软件',
  'inventory sync spreadsheet sellers oversell tool',
  'invoice reconciliation spreadsheet small business software',
  'scheduling spreadsheet small business staff',
  'manual data entry small business software pay',
  'customer support tickets spreadsheet small team',
  'quote estimate spreadsheet contractor software',
  'timesheet tracking excel agency billing',
  'invoice chasing freelance tool pay',
  'purchase order approval small business software',
  'contract renewal tracking spreadsheet saas',
  'reconcile payments stripe xero manual',
  'hiring screening spreadsheet recruiter tool',
  'reddit small business spreadsheet automate',
  'reddit freelance invoice chasing tool',
  '知乎 发票 报销 太麻烦 小公司',
  'v2ex 库存 同步 工具 收费',
];

/** Queries per scan; enough breadth without spending the whole pool at once. */
export const DISCOVERY_QUERIES_PER_SCAN = 10;

/**
 * S1-style cap per query; discovery values breadth over depth. Eight rather
 * than five: the relevance gate now rejects off-topic hits, so each query must
 * bring enough candidates for commercial sources to survive.
 */
export const DISCOVERY_HITS_PER_QUERY = 8;

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
