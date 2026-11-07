/**
 * Buyer-domain taxonomy for the radar. Two angles such as 工厂点检 and 装修验收
 * are different sentences but the same market shape: a small operator chasing
 * timesheets. Comparing domains is how the planner is stopped from filling a
 * scan with variations of one theme, and how coverage is remembered across
 * scans.
 */
const DOMAINS: readonly { id: string; label: string; keywords: readonly string[] }[] = [
  {
    id: 'finance',
    label: '财务与发票',
    keywords: ['发票', '報銷', '报销', '对账', '對賬', '账单', '帳單', '记账', '會計', '会计', 'invoice', 'billing', 'bookkeep', 'accounting', 'reconcil', 'expense'],
  },
  {
    id: 'people',
    label: '人力与招聘',
    keywords: ['招聘', '简历', '履歷', '面试', '面試', '入职', '入職', '员工', '員工', 'hr', 'hiring', 'recruit', 'onboard', 'payroll', '薪資', '薪资'],
  },
  {
    id: 'support',
    label: '客服与支持',
    keywords: ['客服', '售后', '售後', '工单', '工單', 'ticket', 'support', 'helpdesk', 'customer service'],
  },
  {
    id: 'commerce',
    label: '电商与库存',
    keywords: ['库存', '庫存', '电商', '電商', '卖家', '賣家', '订单', '訂單', 'inventory', 'ecommerce', 'e-commerce', 'seller', 'order', 'oversell'],
  },
  {
    id: 'logistics',
    label: '物流与运输',
    keywords: ['物流', '货代', '貨代', '运输', '運輸', '配送', '快递', '快遞', '车队', '車隊', 'shipping', 'freight', 'logistics', 'delivery'],
  },
  {
    id: 'construction',
    label: '建筑与装修',
    keywords: ['建筑', '建築', '装修', '裝修', '工地', '施工', '建材', '工程', '承包商', 'contractor', 'construction', 'renovation', 'site'],
  },
  {
    id: 'manufacturing',
    label: '制造与工厂',
    keywords: ['工厂', '工廠', '车间', '車間', '设备', '設備', '点检', '點檢', '质检', '質檢', '制造', '製造', '生产', '生產', 'factory', 'manufactur', 'equipment', 'inspection'],
  },
  {
    id: 'health',
    label: '医疗与诊所',
    keywords: ['诊所', '診所', '医疗', '醫療', '病历', '病歷', '患者', '医生', '醫生', '牙科', 'clinic', 'medical', 'patient', 'dental', 'healthcare'],
  },
  {
    id: 'education',
    label: '教育与培训',
    keywords: ['教育', '培训', '培訓', '课程', '課程', '讲师', '講師', '学生', '學生', '作业', '作業', '教培', '学校', '學校', 'school', 'course', 'teacher', 'tutor', 'student'],
  },
  {
    id: 'food',
    label: '餐饮与门店',
    keywords: ['餐饮', '餐飲', '餐厅', '餐廳', '门店', '門店', '咖啡', '外卖', '外賣', '店长', '店長', 'restaurant', 'cafe', 'retail store', 'shop'],
  },
  {
    id: 'legal',
    label: '法律与合规',
    keywords: ['法律', '律师', '律師', '合同', '合规', '合規', '审计', '審計', '隐私', '隱私', '法务', '法務', 'legal', 'contract', 'compliance', 'audit', 'privacy'],
  },
  {
    id: 'sales',
    label: '销售与 CRM',
    keywords: ['销售', '銷售', '客户', '客戶', '线索', '線索', '跟进', '跟進', 'crm', 'sales', 'lead', 'pipeline'],
  },
  {
    id: 'fitness',
    label: '健身与运动',
    keywords: ['健身', '私教', '运动', '運動', '训练', '訓練', '教练', '教練', 'gym', 'fitness', 'trainer', 'workout'],
  },
  {
    id: 'property',
    label: '房产与物业',
    keywords: ['房产', '房產', '物业', '物業', '租赁', '租賃', '房东', '房東', '中介', '报修', '報修', 'property', 'landlord', 'tenant', 'real estate'],
  },
  {
    id: 'pets',
    label: '宠物服务',
    keywords: ['宠物', '寵物', '寄养', '寄養', 'vet', 'pet', 'grooming'],
  },
  {
    id: 'events',
    label: '会展与活动',
    keywords: ['会展', '會展', '活动', '活動', '展会', '展會', '婚礼', '婚禮', 'event', 'conference', 'wedding'],
  },
  {
    id: 'agriculture',
    label: '农业与合作社',
    keywords: ['农业', '農業', '农场', '農場', '合作社', 'farm', 'agricultur', 'crop', 'livestock'],
  },
  {
    id: 'insurance',
    label: '保险与理赔',
    keywords: ['保险', '保險', '理赔', '理賠', '保费', '保費', 'insurance', 'claim', 'premium'],
  },
  {
    id: 'devops',
    label: '软件与运维',
    keywords: ['运维', '運維', '部署', '监控', '監控', '模型', '自托管', '開發', '开发', '代码', '代碼', 'devops', 'deploy', 'monitor', 'self-host', 'llm', 'developer'],
  },
  {
    id: 'design',
    label: '设计与创意',
    keywords: ['设计', '設計', '素材', '剪辑', '剪輯', '视频', '視頻', '图片', '圖片', 'design', 'video', 'image', 'editing'],
  },
];

/** Best matching buyer domain, or `null` for a generic angle. */
export function domainOf(text: string): string | null {
  const lower = text.toLowerCase();
  let best: string | null = null;
  let bestScore = 0;

  for (const domain of DOMAINS) {
    let score = 0;
    for (const keyword of domain.keywords) {
      if (lower.includes(keyword.toLowerCase())) score += 1;
    }
    if (score > bestScore) {
      best = domain.id;
      bestScore = score;
    }
  }

  return best;
}

/** Human-readable name for prompts and errors; falls back to the id. */
export function domainLabel(id: string): string {
  return DOMAINS.find((domain) => domain.id === id)?.label ?? id;
}

/** Domain ids covered by a list of angles, in first-seen order. */
export function coveredDomains(angles: readonly string[]): string[] {
  const seen: string[] = [];
  for (const angle of angles) {
    const domain = domainOf(angle);
    if (domain !== null && !seen.includes(domain)) seen.push(domain);
  }
  return seen;
}
