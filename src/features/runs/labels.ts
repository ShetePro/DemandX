/** Why a page was skipped or queued for a person, in the operator's words. */
export const SOURCE_REASON_LABEL: Readonly<Record<string, string>> = {
  login: '需要登录',
  captcha: '验证码',
  blocked: '被拦截',
  robots: 'robots 限制',
  invalid_url: '链接无效',
  near_duplicate: '近似重复',
  CRAWL_ERROR: '抓取异常',
  SNAPSHOT_FAILED: '快照写入失败',
  HTTP_ERROR: 'HTTP 错误',
  TIMEOUT: '请求超时',
  NOT_HTML: '不是网页',
  TOO_LARGE: '页面过大',
};

export function sourceReasonLabel(reason: string | null): string {
  if (reason === null) return '未知原因';
  return SOURCE_REASON_LABEL[reason] ?? reason;
}

export const SOURCE_EVENT_TYPE_LABEL: Readonly<Record<string, string>> = {
  'source.needs_human': '待人工',
  'source.failed': '采集失败',
  'source.skipped': '策略跳过',
};

export function sourceEventTypeLabel(type: string): string {
  return SOURCE_EVENT_TYPE_LABEL[type] ?? type;
}
