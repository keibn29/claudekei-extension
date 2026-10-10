import type { Session } from '@/lib/claude/types';

export type SessionSummaryMeta = {
  additions?: number | string | null;
  deletions?: number | string | null;
  files?: number | null;
  diffs?: Array<{ additions?: number | string | null; deletions?: number | string | null }>;
};

export type SessionNode = {
  session: Session;
  children: SessionNode[];
};

export type SessionGroup = {
  id: string;
  label: string;
  branch: string | null;
  description: string | null;
  isMain: boolean;
  directory: string | null;
  folderScopeKey?: string | null;
  sessions: SessionNode[];
};

export type GroupSearchData = {
  filteredNodes: SessionNode[];
  matchedSessionCount: number;
  folderNameMatchCount: number;
  groupMatches: boolean;
  hasMatch: boolean;
};
