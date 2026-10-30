/**
 * The four views of one conversation. Kept free of imports so both the RSC
 * (which parses `?view=`) and the client tabs can share the vocabulary.
 */
export const THREAD_VIEWS = [
  { value: 'chat', label: '对话' },
  { value: 'evidence', label: '证据' },
  { value: 'report', label: '报告' },
  { value: 'plan', label: '计划' },
] as const;

export type ThreadView = (typeof THREAD_VIEWS)[number]['value'];

/** Anything missing or unknown falls back to the conversation. */
export function parseThreadView(raw: string | string[] | undefined): ThreadView {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return THREAD_VIEWS.find((view) => view.value === value)?.value ?? 'chat';
}
