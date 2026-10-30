import type { Prompt } from '@/lib/llm/port';

import { MAX_ITEMS_PER_PAGE } from './schema';

/** Anything past this is beyond what one extraction call reads or needs. */
export const MAX_EXTRACTION_TEXT = 12_000;

export interface ExtractionPromptInput {
  url: string;
  platform: string;
  /** Readability text of the page; truncated to `MAX_EXTRACTION_TEXT`. */
  text: string;
}

/**
 * The system prompt is the contract the quote gate enforces downstream: the
 * model may only copy, never rewrite. Keeping it here (rather than in the S2
 * runner) lets the eval harness reuse the exact same wording.
 */
export function buildExtractionPrompt({ url, platform, text }: ExtractionPromptInput): Prompt {
  const body = text.slice(0, MAX_EXTRACTION_TEXT);

  const system = [
    '你是需求证据抽取器。唯一的任务是从网页正文中摘录用户自己的原话，并说明这句话能证明什么。',
    '',
    '硬性规则：',
    '1. 只摘录原文：quote 必须是正文中一字不差的连续片段，不得改写、不得概括、不得翻译、不得修正错别字或标点。',
    `2. 一个页面最多 ${MAX_ITEMS_PER_PAGE} 条。宁可少抽，不可凑数；没有把握的片段直接放弃。`,
    '3. 没有可引用的原文时返回 {"items": []}，不得编造句子，也不得补全正文没有的信息。',
    '4. signal 只能是 problem / seeking / paying / switching / recurring 之一，按原话实际表达的含义选择；不同信号分开成不同条目，不得合并。',
    '5. firstHand 仅当作者在描述自己的亲身经历时为 true；转述他人、新闻或评测摘要为 false。',
    '6. publishedAt 只填页面自身标注的发布时间（ISO 8601）；页面没有标注则为 null。',
    '7. priceMentioned 只填原话中明确出现的价格（amount 为正数，currency 为三位货币代码）；没有则为 null。',
    '8. supports 写这句话能证明的事实，doesNotProve 写它不能证明什么，两者各不超过 120 字。',
    '9. 事实、推断、未知必须分开：原话没有说的事情不得写进 supports。',
  ].join('\n');

  const user = [`平台：${platform}`, `地址：${url}`, '', '正文：', '"""', body, '"""'].join('\n');

  return { system, user };
}
