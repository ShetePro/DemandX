'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { SessionState, SessionStatus } from '@/lib/crawl/session-status';
import { cn } from '@/lib/utils/cn';
import { formatRelativeTime } from '@/lib/utils/format';

import type { LoginCheck } from '@/lib/crawl/login-check';

import { checkLoginAction, getSessionStatusAction, startLoginAction } from './actions';
import { PLATFORM_LABELS } from './platforms';

const STATE_LABEL: Readonly<Record<SessionState, string>> = {
  active: '近期使用',
  stale: '较久未用',
  missing: '无会话目录',
};

const STATE_TONE: Readonly<Record<SessionState, 'success' | 'warning' | 'neutral'>> = {
  active: 'success',
  stale: 'warning',
  missing: 'neutral',
};

const POLL_INTERVAL_MS = 3000;
/** ~10 minutes: long enough to finish a login, short enough to stop a dead poll. */
const MAX_POLLS = 200;

export interface PlatformCardProps {
  status: SessionStatus;
  /** Direct link, used when the spawned browser window cannot open. */
  loginUrl?: string | undefined;
}

/**
 * One platform's session directory. The badge reads only the directory mtime;
 * "recently active" deliberately does not claim "logged in", because a
 * directory can be touched by a launch that never completed a login.
 */
export function PlatformCard({ status: initialStatus, loginUrl }: PlatformCardProps) {
  const { platform } = initialStatus;
  const label = PLATFORM_LABELS[platform] ?? platform;

  const [status, setStatus] = useState(initialStatus);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [login, setLogin] = useState<LoginCheck | null>(null);

  async function check(): Promise<void> {
    setChecking(true);
    setLogin(null);
    try {
      const result = await checkLoginAction(platform);
      if (result.ok) setLogin(result.value);
      else setLogin({ platform, state: 'unknown', found: [], message: result.message });
    } finally {
      setChecking(false);
    }
  }

  async function start() {
    setMessage(null);
    setPending(true);

    const result = await startLoginAction(platform);
    if (!result.ok) {
      setPending(false);
      setMessage(result.message);
      toast.error(result.message);
      return;
    }
    toast.success(`已打开 ${label} 登录窗口`);
  }

  useEffect(() => {
    if (!pending) return;

    let polls = 0;
    let cancelled = false;
    const timer = setInterval(() => {
      polls += 1;
      void (async () => {
        const result = await getSessionStatusAction(platform);
        if (cancelled) return;

        if (result.ok) {
          setStatus(result.value);
          if (result.value.state === 'active') {
            setPending(false);
            setMessage('已检测到会话目录更新，可以关闭登录窗口。');
            toast.success(`${label} 会话目录已更新`);
            return;
          }
        }

        if (polls >= MAX_POLLS) {
          setPending(false);
          setMessage('未检测到会话更新，请刷新页面查看。');
        }
      })();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pending, platform, label]);

  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">{label}</h3>
        <Badge tone={STATE_TONE[status.state]}>{STATE_LABEL[status.state]}</Badge>
      </div>

      <p className="text-[11px] text-muted" title={status.profileDir}>
        目录 ~/.demandx/browser/{platform}
      </p>
      <p className="text-[11px] text-faint">
        最近更新：
        {status.lastUsedAt ? formatRelativeTime(new Date(status.lastUsedAt)) : '从未'}
      </p>

      <div className="mt-1 flex items-center gap-2">
        <Button size="sm" onClick={() => void start()} disabled={pending}>
          {pending ? '等待登录…' : status.state === 'missing' ? '去登录' : '重新登录'}
        </Button>
        {pending ? (
          <span className="text-[11px] text-muted">登录后自动刷新</span>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void check()}
          disabled={checking}
        >
          {checking ? '检测中…' : '检测登录'}
        </Button>
        {loginUrl !== undefined ? (
          <a
            href={loginUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-accent underline-offset-2 hover:underline"
          >
            窗口打不开？手动打开
          </a>
        ) : null}
      </div>

      {login ? (
        <p
          role="status"
          className={cn(
            'text-[11px]',
            login.state === 'logged-in'
              ? 'text-success'
              : login.state === 'logged-out'
                ? 'text-warning'
                : 'text-muted',
          )}
        >
          {login.state === 'logged-in'
            ? `已登录（cookie：${login.found.join(', ')}）`
            : login.state === 'logged-out'
              ? '未检测到登录 cookie，需要重新登录'
              : `无法检测：${login.message ?? '浏览器配置被占用'}`}
        </p>
      ) : null}

      {message ? (
        <p role="status" className="text-[11px] text-muted">
          {message}
        </p>
      ) : null}

      {pending ? (
        <p className="text-[11px] text-faint">
          窗口一直是空白？把 ~/.demandx/logs/login-{platform}.log 发给我排查。
        </p>
      ) : null}
    </li>
  );
}
