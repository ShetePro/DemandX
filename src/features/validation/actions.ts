'use server';

import { revalidatePath } from 'next/cache';

import { toggleTask, type ValidationResult } from '@/lib/validation/repository';

export type ToggleTaskOutcome = { id: number; runId: number; done: boolean };

/**
 * Persist one checkbox. The board updates optimistically and calls this; a
 * failure is returned as a value so the client can roll the checkbox back
 * instead of showing a task as done when the database disagrees.
 */
export async function toggleTaskAction(
  rawId: unknown,
  rawDone: unknown,
): Promise<ValidationResult<ToggleTaskOutcome>> {
  const result = await toggleTask(rawId, rawDone);
  if (!result.ok) return result;

  revalidatePath(`/runs/${result.value.runId}/plan`);
  return {
    ok: true,
    value: { id: result.value.id, runId: result.value.runId, done: result.value.done },
  };
}
