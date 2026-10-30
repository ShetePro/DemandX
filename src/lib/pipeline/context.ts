/**
 * What every stage of the pipeline receives. `angles` names the search angles
 * S0 decided on; a stage that can rebuild them from the idea (S1 does, with
 * templates and no LLM) only treats the list as a filter.
 */
export interface RunContext {
  runId: number;
  /** The user's raw pitch, already trimmed. */
  idea: string;
  angles: string[];
  /** `null` means the run has no deadline; stages never invent one. */
  deadlineAt: Date | null;
}

/** Failures a stage may return instead of throwing across the pipeline boundary. */
export type AppErrorCode =
  'DEADLINE_EXCEEDED' | 'QUOTA_EXCEEDED' | 'STORAGE_FAILED' | 'CRAWL_UNAVAILABLE' | 'INVALID_INPUT';

/**
 * The shape a stage hands back to the runner: an updated context on success
 * (carrying whatever the stage learned), or a typed failure the runner turns
 * into a terminal event. A stage failure never throws; a programming error
 * still does.
 */
export type StageResult =
  { ok: true; context: RunContext } | { ok: false; code: AppErrorCode; detail?: unknown };
