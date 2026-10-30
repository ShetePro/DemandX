/**
 * The five decisions of spec §9, evaluated in order: the first matching rule
 * wins, so a D-grade report is abandoned even when its total looks great.
 */

import type { CredibilityGrade } from './credibility';

export type Decision = '建议开发' | '建议先验证，再开发' | '建议调整定位' | '建议暂缓' | '建议放弃';

export interface DecisionInput {
  /** `OpportunityScore.total`, 0–100. */
  total: number;
  credibility: CredibilityGrade;
  /** 真实需求 score (0–20). */
  needs: number;
  /** 付费意愿 score (0–20). */
  payment: number;
  /** 技术可行性 score (0–10). */
  feasibility: number;
}

export interface DecisionResult {
  decision: Decision;
  /** Which rule fired and on which numbers, in the report's language (Chinese). */
  reason: string;
  /** One action sentence; the concrete experiment when the call is 先验证. */
  nextStep: string;
}

/** §9 thresholds shared by the rules below. */
const LOW_PAYMENT = 6;
const LOW_NEEDS = 6;
const LOW_FEASIBILITY = 5;
const MID_TOTAL = 50;
const HIGH_TOTAL = 70;

/** The cheapest experiment that can falsify a 先验证 case inside two weeks. */
const VERIFY_NEXT_STEP = '5 个目标用户访谈 + 一页落地页 + 价格测试（如 ¥99/月），两周内看付费转化';

/** Junk input (NaN, ±Infinity) is treated as a zero score, not as a pass. */
function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function decide({
  total,
  credibility,
  needs,
  payment,
  feasibility,
}: DecisionInput): DecisionResult {
  const totalPoints = count(total);
  const needPoints = count(needs);
  const paymentPoints = count(payment);
  const feasibilityPoints = count(feasibility);

  // ① 可信度 D，或（需求 ≤6 且付费 = 0）→ 放弃.
  if (credibility === 'D') {
    return {
      decision: '建议放弃',
      reason: '可信度 D：证据不足以支撑任何结论，分数再高也不构成机会',
      nextStep: '停止该方向，把本轮证据归档，转去采集付费信号更强的问题',
    };
  }

  if (needPoints <= LOW_NEEDS && paymentPoints === 0) {
    return {
      decision: '建议放弃',
      reason: `需求仅 ${needPoints} 分（≤${LOW_NEEDS}）且无任何付费证据`,
      nextStep: '停止该方向，把本轮证据归档，转去采集付费信号更强的问题',
    };
  }

  // ② 付费 ≤6 且总分 <50 → 调整定位.
  if (paymentPoints <= LOW_PAYMENT && totalPoints < MID_TOTAL) {
    return {
      decision: '建议调整定位',
      reason: `付费意愿仅 ${paymentPoints} 分（≤${LOW_PAYMENT}）且总分 ${totalPoints} 分（<${MID_TOTAL}）：有人抱怨，但没人在为它花钱`,
      nextStep: '用已有的付费证据反推买家画像，把定位改成他们已经在付费的邻近需求，再重跑一轮采集',
    };
  }

  // ③ 技术可行性 ≤5 且总分 ≥50 → 暂缓.
  if (feasibilityPoints <= LOW_FEASIBILITY && totalPoints >= MID_TOTAL) {
    return {
      decision: '建议暂缓',
      reason: `技术可行性仅 ${feasibilityPoints} 分（≤${LOW_FEASIBILITY}），存在未解决的依赖或合规阻断，而总分已有 ${totalPoints} 分`,
      nextStep: '先解决技术依赖或合规阻断项（写出替代方案与成本），再重跑评分',
    };
  }

  // ④ 总分 ≥70 且可信度 A/B → 开发.
  if (totalPoints >= HIGH_TOTAL && (credibility === 'A' || credibility === 'B')) {
    return {
      decision: '建议开发',
      reason: `总分 ${totalPoints} 分（≥${HIGH_TOTAL}）且可信度 ${credibility}，需求与付费证据都立得住`,
      nextStep: '按 14 天最小可用版本拆里程碑，优先交付已验证的核心流程',
    };
  }

  // ⑤ 其余 → 先验证，再开发.
  return {
    decision: '建议先验证，再开发',
    reason:
      totalPoints >= HIGH_TOTAL
        ? `总分 ${totalPoints} 分虽过 ${HIGH_TOTAL}，但可信度仅 ${credibility}，高分建立在弱证据上`
        : `总分 ${totalPoints} 分（<${HIGH_TOTAL}），证据方向成立但未达到开发门槛`,
    nextStep: VERIFY_NEXT_STEP,
  };
}
