/**
 * Starter directions for the new-research screen.
 *
 * These are topics a person can actually investigate — each one is a raw idea
 * a run can be started from, never a popularity claim. The screen matches them
 * against what the user types and appends their own recent pitches from the
 * `ideas` table.
 */
export type ResearchSuggestion = {
  /** Stable key for React and for deduplication. */
  key: string;
  /** Short chip text. */
  label: string;
  /** Full prompt placed in the composer when the chip is picked. */
  idea: string;
  keywords: readonly string[];
};

export const SUGGESTION_BATCH_SIZE = 6;

export const BUILTIN_SUGGESTIONS: readonly ResearchSuggestion[] = [
  {
    key: 'cross-border-inventory',
    label: '跨境库存同步',
    idea: '跨境卖家在多个平台之间手工同步库存，旺季经常超卖',
    keywords: ['跨境', '库存', '同步', '超卖', '电商'],
  },
  {
    key: 'small-team-invoices',
    label: '小团队发票与报销',
    idea: '小团队用表格管理发票和报销，月底对账总要熬夜',
    keywords: ['发票', '报销', '对账', '财务', '小团队'],
  },
  {
    key: 'podcast-editing',
    label: '播客剪辑',
    idea: '独立播客每期剪辑要花八小时，找人代剪又怕风格不一致',
    keywords: ['播客', '剪辑', '音频', '内容创作'],
  },
  {
    key: 'pet-prescription-food',
    label: '宠物处方粮订阅',
    idea: '宠物处方粮要定期跑医院补货，主人希望有人送粮上门',
    keywords: ['宠物', '处方粮', '订阅', '补货'],
  },
  {
    key: 'freelance-contracts',
    label: '自由职业合同与收款',
    idea: '自由职业者接私活没有合同模板，遇到拖款只能自己催',
    keywords: ['自由职业', '合同', '收款', '拖款'],
  },
  {
    key: 'rental-deposit',
    label: '租房押金核对',
    idea: '租客退租时押金被各种理由扣，没人帮忙逐条核对',
    keywords: ['租房', '押金', '退租', '租客'],
  },
  {
    key: 'restaurant-purchasing',
    label: '小餐馆采购比价',
    idea: '小餐馆每天靠微信问价采购，菜价波动大又没有记录',
    keywords: ['餐馆', '采购', '比价', '菜价'],
  },
  {
    key: 'used-gear-pricing',
    label: '二手器材估价',
    idea: '二手摄影器材出手前不知道合理价格，怕被买家压价',
    keywords: ['二手', '器材', '估价', '摄影'],
  },
  {
    key: 'group-buy-sorting',
    label: '社区团购分拣',
    idea: '社区团购团长每天手工分拣订单，分错货就要自己赔',
    keywords: ['团购', '分拣', '订单', '团长'],
  },
  {
    key: 'grad-school-materials',
    label: '考研资料整理',
    idea: '考研学生收集的院校资料散在十几个群里，无法横向比较',
    keywords: ['考研', '资料', '院校', '信息'],
  },
];

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Built-in directions first, then the user's own recent pitches. Deduplication
 * is by full idea, so a saved pitch that matches a built-in chip is not shown
 * twice.
 */
export function mergeSuggestions(recentIdeas: readonly string[]): ResearchSuggestion[] {
  const merged: ResearchSuggestion[] = [...BUILTIN_SUGGESTIONS];
  const seen = new Set(merged.map((suggestion) => normalize(suggestion.idea)));

  recentIdeas.forEach((raw, index) => {
    const idea = raw.trim();
    if (idea === '') return;

    const key = normalize(idea);
    if (seen.has(key)) return;
    seen.add(key);

    const compact = idea.replace(/\s+/g, ' ');
    merged.push({
      key: `recent-${index}`,
      label: compact.length > 18 ? `${compact.slice(0, 18)}…` : compact,
      idea,
      keywords: [],
    });
  });

  return merged;
}

/** Suggestions whose keywords, label or prompt contain the query. */
export function matchSuggestions(
  suggestions: readonly ResearchSuggestion[],
  query: string,
): ResearchSuggestion[] {
  const needle = normalize(query);
  if (needle === '') return [];

  return suggestions.filter(
    (suggestion) =>
      normalize(suggestion.label).includes(needle) ||
      normalize(suggestion.idea).includes(needle) ||
      suggestion.keywords.some((keyword) => normalize(keyword).includes(needle)),
  );
}

/**
 * A fixed-size page of chips. The page wraps around, so "换一批" always returns
 * a full set even when the pool is smaller than one page.
 */
export function suggestionWindow(
  suggestions: readonly ResearchSuggestion[],
  batch: number,
  size = SUGGESTION_BATCH_SIZE,
): ResearchSuggestion[] {
  if (suggestions.length === 0 || size <= 0) return [];

  const start = ((batch % Math.ceil(suggestions.length / size)) * size) % suggestions.length;
  const count = Math.min(size, suggestions.length);
  const window: ResearchSuggestion[] = [];

  for (let offset = 0; offset < count; offset += 1) {
    window.push(suggestions[(start + offset) % suggestions.length] as ResearchSuggestion);
  }

  return window;
}
