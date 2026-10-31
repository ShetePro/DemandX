'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { deleteThread, type DeleteThreadResult, type Result } from '@/lib/runs/repository';

const deleteThreadInputSchema = z
  .number()
  .int('threadId 必须是整数')
  .positive('threadId 必须为正数');

/**
 * Removes a conversation from the sidebar. The layout's thread list is server
 * data, so the list is revalidated here; the client also refreshes after a
 * successful delete to drop the row immediately.
 */
export async function deleteThreadAction(threadId: unknown): Promise<Result<DeleteThreadResult>> {
  const parsed = deleteThreadInputSchema.safeParse(threadId);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: parsed.error.issues[0]?.message ?? 'threadId 无效',
    };
  }

  const deleted = await deleteThread(parsed.data);
  if (deleted.ok) revalidatePath('/', 'layout');
  return deleted;
}
