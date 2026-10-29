import {
  Database,
  FileText,
  LayoutDashboard,
  MessageSquare,
  SlidersHorizontal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * One navigable destination. Shared by the sidebar, the mobile drawer and the
 * command palette so the three entry points can never drift apart.
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

/** `/runs/1/` and `/runs/1` must match alike. */
function normalize(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

/**
 * Report and evidence library live under the same `/runs` tree, so they cannot
 * both match on a bare prefix: `/runs/:id` (and `/runs/:id/report`) is the
 * report, only `/runs/:id/evidence` is the evidence library.
 *
 * The links point at `/runs/latest/*` because there is no run yet — the
 * concrete run routes arrive with the run pages (T0.9+).
 */
const REPORT_PATH = /^\/runs(?:\/[^/]+(?:\/report)?)?$/;
const EVIDENCE_PATH = /^\/runs\/[^/]+\/evidence$/;

export const NAV_ITEMS: readonly NavItem[] = [
  {
    href: '/',
    label: '工作台',
    icon: LayoutDashboard,
    keywords: ['home', 'dashboard'],
    isActive: (pathname) => normalize(pathname) === '/',
  },
  {
    href: '/threads',
    label: '对话',
    icon: MessageSquare,
    keywords: ['chat', 'thread', 'threads'],
    isActive: (pathname) => {
      const path = normalize(pathname);
      return path === '/threads' || path.startsWith('/threads/');
    },
  },
  {
    href: '/runs/latest/report',
    label: '报告',
    icon: FileText,
    keywords: ['report', 'runs'],
    isActive: (pathname) => REPORT_PATH.test(normalize(pathname)),
  },
  {
    href: '/runs/latest/evidence',
    label: '证据库',
    icon: Database,
    keywords: ['evidence', 'runs'],
    isActive: (pathname) => EVIDENCE_PATH.test(normalize(pathname)),
  },
];

/** Sidebar footer + command palette entry for the settings tree. */
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
