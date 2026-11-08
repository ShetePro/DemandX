/**
 * Operator-facing platform names. Kept outside the client component so the RSC
 * page and the card render the same label from one place.
 */
export const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  xiaohongshu: '小红书',
  douyin: '抖音',
  zhihu: '知乎',
};


/** Login pages the platform cards open; the script receives the same URL. */
export const PLATFORM_LOGIN_URLS: Readonly<Record<string, string>> = {
  xiaohongshu: 'https://www.xiaohongshu.com',
  douyin: 'https://www.douyin.com',
  zhihu: 'https://www.zhihu.com',
};
