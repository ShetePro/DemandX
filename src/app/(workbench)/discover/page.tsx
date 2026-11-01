import type { Metadata } from 'next';

import { OpportunityPage } from '@/features/discovery/opportunity-page';

export const metadata: Metadata = { title: '机会雷达 · DemandX' };
export const dynamic = 'force-dynamic';

/**
 * A page rather than a dialog: the scan needs room for provenance, timings and
 * several opportunities, and the route gives the operator a link to return to.
 */
export default function DiscoverPage() {
  return <OpportunityPage />;
}
