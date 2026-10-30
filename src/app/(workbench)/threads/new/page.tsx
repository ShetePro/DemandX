import { NewResearchScreen } from '@/features/chat/new-research-screen';
import { listRecentIdeaTitles } from '@/lib/runs/repository';

// Recent pitches are read per request; a build-time snapshot would go stale.
export const dynamic = 'force-dynamic';

/** The newest real pitches become suggestion chips on the first screen. */
const RECENT_IDEA_LIMIT = 5;

export default async function NewThreadPage() {
  const recent = await listRecentIdeaTitles(RECENT_IDEA_LIMIT);
  if (!recent.ok) throw new Error(recent.message);

  return <NewResearchScreen recentIdeas={recent.value} />;
}
