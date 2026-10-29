import { Plus } from 'lucide-react';
import { redirect } from 'next/navigation';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { createThreadAction } from '@/features/chat/actions';

/**
 * Opening a conversation is one click: a thread always hangs off an idea row,
 * and the pitch itself is captured by the first chat turn / run.
 */
async function createThread(): Promise<void> {
  'use server';

  const result = await createThreadAction({ title: '新研究' });
  if (!result.ok) throw new Error(result.message);

  redirect(`/threads/${result.value.threadId}`);
}

export default function NewThreadPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6.5">
      <PageHeader title="新建研究" description="先开一个会话，再在对话里描述产品想法或用户抱怨" />

      <form action={createThread}>
        <Button type="submit">
          <Plus className="size-4" />
          新建研究
        </Button>
      </form>
    </div>
  );
}
