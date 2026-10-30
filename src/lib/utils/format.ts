const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** `YYYY-MM-DD` in the local time zone (never shifts across the UTC day boundary). */
export function formatDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Relative Chinese timestamp used by run tables and evidence rows.
 *
 * Under a minute → 刚刚, under an hour → `N 分钟前`, under a day → `N 小时前`,
 * under a week → `N 天前`, otherwise the absolute `YYYY-MM-DD` date. The
 * comparison is purely elapsed time, so 23:59 → 00:01 the next day is
 * `2 分钟前`, not a day boundary.
 */
export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const elapsed = now.getTime() - date.getTime();
  if (elapsed < MINUTE_MS) return '刚刚';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} 分钟前`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} 小时前`;
  if (elapsed < 7 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)} 天前`;
  return formatDate(date);
}

/**
 * Human duration for run timings: seconds under a minute, minutes under an
 * hour, then hours with the remaining minutes. Negative or non-finite input
 * renders `—` rather than a made-up number.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';

  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;

  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

/**
 * Render a 0–100 rubric score as an integer string.
 *
 * @throws {RangeError} when the score is outside 0–100 or not a finite number.
 */
export function formatScore(score: number): string {
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new RangeError(`总分必须在 0 到 100 之间，收到 ${score}`);
  }
  return String(Math.round(score));
}

/**
 * Format an amount with its ISO 4217 currency code via `Intl`.
 * Unknown currency codes cannot throw into a render path, so they fall back to
 * a plain `CODE amount` string.
 */
export function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(amount);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return `${currency} ${amount}`;
  }
}
