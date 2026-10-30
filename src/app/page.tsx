import { redirect } from 'next/navigation';

/**
 * Conversations are the navigation unit: the root opens the new-research
 * screen, and the sidebar lists every conversation that already exists.
 */
export default function RootPage() {
  redirect('/threads/new');
}
