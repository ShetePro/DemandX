/**
 * Angle matching between the planner and the analysis model. The planner is
 * told to use short labels, but models still echo a shortened or expanded
 * variant of one ("独立课程讲师备课" for "独立课程讲师备课：培训师…"), and an
 * exact-match check would throw away an otherwise valid idea.
 */
function key(angle: string): string {
  return angle.trim().toLowerCase().replace(/[\s:：、,/]+/g, '');
}

/**
 * The planned angle this candidate belongs to, or `null` when it names none
 * of them. Containment is checked both ways: models both shorten and expand.
 */
export function resolvePlannedAngle(candidate: string, planned: readonly string[]): string | null {
  const candidateKey = key(candidate);
  if (candidateKey === '') return null;

  const exact = planned.find((angle) => key(angle) === candidateKey);
  if (exact !== undefined) return exact;

  const contained = planned.find((angle) => {
    const plannedKey = key(angle);
    return plannedKey.includes(candidateKey) || candidateKey.includes(plannedKey);
  });
  return contained ?? null;
}
