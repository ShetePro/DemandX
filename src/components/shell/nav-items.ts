import { SlidersHorizontal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * One navigable destination. Shared by the sidebar, the mobile drawer and the
 * command palette so the entry points can never drift apart.
 */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Extra search terms for the command palette (English names, synonyms). */
  keywords: string[];
  /** Whether `pathname` belongs to this item. */
  isActive: (pathname: string) => boolean;
}

/** `/settings/llm/` and `/settings/llm` must match alike. */
function normalize(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

/**
 * Sidebar footer + command palette entry for the settings tree. Conversations
 * are the primary navigation now, so this is the only fixed destination left.
 */
export const SETTINGS_ITEM: NavItem = {
  href: '/settings/llm',
  label: 'LLM 与采集',
  icon: SlidersHorizontal,
  keywords: ['设置', 'settings', 'llm', '采集'],
  isActive: (pathname) => {
    const path = normalize(pathname);
    return path === '/settings' || path.startsWith('/settings/');
  },
};
