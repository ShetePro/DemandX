'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { ProviderRow } from '@/lib/llm/types';

import { deleteProviderAction } from './actions';

/**
 * Deleting is guarded by the repository (`PROVIDER_REFERENCED` when a chain
 * still points here), so the dialog only asks for confirmation and shows the
 * refusal verbatim.
 */
export function ProviderDelete({ provider }: { provider: ProviderRow }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function remove() {
    setError(null);
    setPending(true);
    try {
      const result = await deleteProviderAction(provider.id);
      if (!result.ok) {
        setError(result.message);
        toast.error(result.message);
        return;
      }
      toast.success(`已删除 ${provider.name}`);
      setOpen(false);
      router.push('/settings/llm');
      router.refresh();
    } catch {
      setError('删除失败：网络错误');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="danger" size="sm">
          删除
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>删除 {provider.name}？</DialogTitle>
          <DialogDescription>
            模型缓存会一起删除。仍被链路引用的 provider 会被拒绝删除，需要先从链里移除。
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger"
          >
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button variant="danger" onClick={remove} disabled={pending}>
            {pending ? '删除中…' : '确认删除'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
