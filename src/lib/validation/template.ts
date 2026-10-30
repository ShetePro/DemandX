/**
 * The 14-day validation plan a run starts with. One task per day: the first
 * week is discovery and a landing page, the second week turns interest into a
 * real payment attempt and closes with a written verdict. Titles stay short
 * because the board renders them as checkbox labels.
 */
export const VALIDATION_PLAN_DAYS = 14;

export interface ValidationPlanDay {
  day: number;
  title: string;
}

export const DEFAULT_PLAN: readonly ValidationPlanDay[] = [
  { day: 1, title: '列出 10 位目标用户，写下他们现在的替代方案' },
  { day: 2, title: '约访 5 位目标用户，做 20 分钟问题访谈（只问过去行为）' },
  { day: 3, title: '整理访谈记录，标出“已经在付费”的原话与出处' },
  { day: 4, title: '写出价值主张与最小可交付范围，明确这次不做什么' },
  { day: 5, title: '搭建单页落地页，只保留一个行动按钮' },
  { day: 6, title: '用两个渠道各投放一次落地页链接，记录来源与访问量' },
  { day: 7, title: '回访 3 位访问者，追问他们留下或离开的真实原因' },
  { day: 8, title: '设计三档价格锚点，准备价格测试的问题与展示方式' },
  { day: 9, title: '做一次价格测试，记录选择、犹豫点与拒绝理由' },
  { day: 10, title: '向 5 位最有意向的用户发起真实付款请求（可退款）' },
  { day: 11, title: '跟进付款结果，记录未付款者选择的替代方案' },
  { day: 12, title: '复盘漏斗：访问 → 留资 → 价格测试 → 付款各环节转化' },
  { day: 13, title: '计算获客成本与回收周期，逐条核对关键假设' },
  { day: 14, title: '写出验证结论：继续、调整还是放弃，并列明未验证项' },
];
