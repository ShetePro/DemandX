import type { DiscoveryResult } from '@/lib/discovery/types';

export type ScanPhase = 'plan' | 'search' | 'filter' | 'model';

export type ScanResult =
  { ok: true; value: DiscoveryResult } | { ok: false; code: string; message: string };

/**
 * Reads the NDJSON scan stream: phase events drive the stepper, the result (or
 * error) ends it. A transport failure is reported as a normal failure object,
 * so the page never has to distinguish fetch errors from scan errors.
 */
export async function streamDiscoveryScan(
  excludeUrls: readonly string[],
  directions: readonly string[],
  onPhase: (phase: ScanPhase) => void,
): Promise<ScanResult> {
  let response: Response;
  try {
    response = await fetch('/api/discovery/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ excludeUrls, directions }),
    });
  } catch {
    return { ok: false, code: 'NETWORK', message: '扫描请求失败：无法连接服务端' };
  }

  if (!response.ok || response.body === null) {
    return { ok: false, code: 'HTTP', message: `扫描请求失败：HTTP ${response.status}` };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const parsed = parseEvent(line);
      if (parsed === null) continue;
      if (parsed.type === 'phase') onPhase(parsed.phase);
      else if (parsed.type === 'result') return { ok: true, value: parsed.value };
      else return { ok: false, code: parsed.code, message: parsed.message };
    }
  }

  return { ok: false, code: 'SCAN_INCOMPLETE', message: '扫描流提前结束，请重试' };
}

type StreamEvent =
  | { type: 'phase'; phase: ScanPhase }
  | { type: 'result'; value: DiscoveryResult }
  | { type: 'error'; code: string; message: string };

function parseEvent(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;

  if (record['type'] === 'phase') {
    const phase = record['phase'];
    if (
      phase === 'plan' ||
      phase === 'search' ||
      phase === 'filter' ||
      phase === 'model'
    ) {
      return { type: 'phase', phase };
    }
    return null;
  }

  if (record['type'] === 'result' && typeof record['value'] === 'object') {
    return { type: 'result', value: record['value'] as DiscoveryResult };
  }

  if (record['type'] === 'error') {
    return {
      type: 'error',
      code: typeof record['code'] === 'string' ? record['code'] : 'SCAN_FAILED',
      message: typeof record['message'] === 'string' ? record['message'] : '扫描失败',
    };
  }

  return null;
}
