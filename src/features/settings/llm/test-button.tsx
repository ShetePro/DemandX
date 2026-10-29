'use client';

import { Zap } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { testProviderAction } from './actions';

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; text: string }
  | { kind: 'error'; text: string };

export type TestButtonProps = {
  providerId: number;
  providerName: string;
};

/**
 * One minimal call through the provider's own adapter. A failure is shown as
 * the action reported it — message plus HTTP status — never swallowed.
 */
export function TestButton({ providerId, providerName }: TestButtonProps) {
  const [state, setState] = useState<TestState>({ kind: 'idle' });

  async function run() {
    setState({ kind: 'testing' });
    try {
      const result = await testProviderAction(providerId);
      if (result.ok) {
        setState({
          kind: 'ok',
          text: `${result.value.status} · ${result.value.latencyMs} ms · ${result.value.model}`,
        });
        return;
      }
      setState({
        kind: 'error',
        text: `${result.message}${result.status > 0 ? ` · HTTP ${result.status}` : ''}`,
      });
    } catch {
      setState({ kind: 'error', text: '测试失败：网络错误' });
    }
  }

  return (
    <section
      aria-labelledby="test-heading"
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm"
    >
      <div>
        <h2 id="test-heading" className="text-sm font-semibold text-fg">
          测试连接
        </h2>
        <p className="mt-0.5 text-[11px] text-faint">发送一次“只回复 ok”的最小请求</p>
      </div>

      <Button variant="ghost" onClick={run} disabled={state.kind === 'testing'}>
        <Zap className="size-3.5" aria-hidden />
        {state.kind === 'testing' ? '测试中…' : `测试 ${providerName}`}
      </Button>

      {state.kind === 'ok' ? (
        <p role="status" className="text-[11px] text-success">
          {state.text}
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <p role="alert" className="text-[11px] text-danger">
          {state.text}
        </p>
      ) : null}
    </section>
  );
}
