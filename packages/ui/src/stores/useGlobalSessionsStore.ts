import { create } from 'zustand';
import type { Session } from '@/lib/claude/types';
import { listGlobalSessionPages } from '@/stores/globalSessions';

type GlobalSessionsStatus = 'idle' | 'loading' | 'ready' | 'error';

type LoadResult = {
  activeSessions: Session[];
};

type GlobalSessionsState = {
  activeSessions: Session[];
  sessionsByDirectory: Map<string, Session[]>;
  hasLoaded: boolean;
  status: GlobalSessionsStatus;
  loadSessions: (fallbackActive?: Session[]) => Promise<LoadResult>;
  applySnapshot: (activeSessions: Session[], status?: GlobalSessionsStatus) => void;
  upsertSession: (session: Session) => void;
  removeSessions: (ids: Iterable<string>) => void;
};

const PAGE_SIZE = 200;

let inflightLoad: Promise<LoadResult> | null = null;

const normalizePath = (value?: string | null): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const replaced = trimmed.replace(/\\/g, '/');
  if (replaced === '/') {
    return '/';
  }
  return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

export const resolveGlobalSessionDirectory = (session: Session): string | null => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };

  return normalizePath(record.directory ?? null)
    ?? normalizePath(record.project?.worktree ?? null);
};

const buildSessionsByDirectory = (sessions: Session[]): Map<string, Session[]> => {
  const next = new Map<string, Session[]>();
  for (const session of sessions) {
    const directory = resolveGlobalSessionDirectory(session);
    if (!directory) {
      continue;
    }
    const existing = next.get(directory);
    if (existing) {
      existing.push(session);
      continue;
    }
    next.set(directory, [session]);
  }
  return next;
};

const getSessionSignature = (session: Session): string => {
  return [
    session.id,
    session.title ?? '',
    session.time?.created ?? 0,
    session.time?.updated ?? 0,
    resolveGlobalSessionDirectory(session) ?? '',
  ].join(':');
};

const sameSessionList = (prev: Session[], next: Session[]): boolean => {
  if (prev === next) {
    return true;
  }
  if (prev.length !== next.length) {
    return false;
  }
  for (let index = 0; index < prev.length; index += 1) {
    if (getSessionSignature(prev[index]) !== getSessionSignature(next[index])) {
      return false;
    }
  }
  return true;
};

const upsertSessionIntoList = (sessions: Session[], session: Session): Session[] => {
  const index = sessions.findIndex((candidate) => candidate.id === session.id);
  if (index === -1) {
    return [session, ...sessions];
  }
  if (getSessionSignature(sessions[index]) === getSessionSignature(session)) {
    return sessions;
  }
  const next = [...sessions];
  next[index] = session;
  return next;
};

const mergeSessionLists = (existing: Session[], incoming?: Session[]): Session[] => {
  if (!incoming || incoming.length === 0) {
    return existing;
  }

  if (existing.length === 0) {
    return incoming;
  }

  const byId = new Map(existing.map((session) => [session.id, session]));
  incoming.forEach((session) => {
    byId.set(session.id, session);
  });

  const ordered: Session[] = [];
  const seen = new Set<string>();

  existing.forEach((session) => {
    const next = byId.get(session.id);
    if (!next) {
      return;
    }
    ordered.push(next);
    seen.add(session.id);
  });

  incoming.forEach((session) => {
    if (seen.has(session.id)) {
      return;
    }
    const next = byId.get(session.id);
    if (next) {
      ordered.push(next);
      seen.add(session.id);
    }
  });

  return ordered;
};

const applySnapshot = (
  state: GlobalSessionsState,
  activeSessions: Session[],
  status: GlobalSessionsStatus,
): Partial<GlobalSessionsState> | GlobalSessionsState => {
  const nextActiveSessions = sameSessionList(state.activeSessions, activeSessions)
    ? state.activeSessions
    : activeSessions;
  const nextSessionsByDirectory = nextActiveSessions === state.activeSessions
    ? state.sessionsByDirectory
    : buildSessionsByDirectory(nextActiveSessions);

  if (
    nextActiveSessions === state.activeSessions
    && nextSessionsByDirectory === state.sessionsByDirectory
    && state.hasLoaded
    && state.status === status
  ) {
    return state;
  }

  return {
    activeSessions: nextActiveSessions,
    sessionsByDirectory: nextSessionsByDirectory,
    hasLoaded: true,
    status,
  };
};

export const useGlobalSessionsStore = create<GlobalSessionsState>((set, get) => ({
  activeSessions: [],
  sessionsByDirectory: new Map(),
  hasLoaded: false,
  status: 'idle',

  applySnapshot: (activeSessions, status = 'ready') => {
    set((state) => applySnapshot(state, activeSessions, status));
  },

  loadSessions: async (fallbackActive) => {
    if (inflightLoad) {
      return inflightLoad;
    }

    set((state) => (state.status === 'loading' ? state : { status: 'loading' }));

    inflightLoad = (async () => {
      const current = get();

      try {
        const activeResult = await listGlobalSessionPages({ pageSize: PAGE_SIZE }).then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason: unknown) => ({ status: 'rejected' as const, reason }),
        );

        const fallbackSnapshot = mergeSessionLists(current.activeSessions, fallbackActive);
        const nextActiveSessions = activeResult.status === 'fulfilled'
          ? activeResult.value
          : fallbackSnapshot;

        if (activeResult.status === 'rejected') {
          console.warn('[GlobalSessions] Failed to load active sessions, preserving existing snapshot with fallback merge:', activeResult.reason);
        }

        set((state) => applySnapshot(state, nextActiveSessions, 'ready'));
        return { activeSessions: nextActiveSessions };
      } catch (error) {
        const nextActiveSessions = mergeSessionLists(current.activeSessions, fallbackActive);
        console.warn('[GlobalSessions] Failed to load sessions, using fallback snapshot:', error);
        set((state) => applySnapshot(state, nextActiveSessions, 'error'));
        return { activeSessions: nextActiveSessions };
      } finally {
        inflightLoad = null;
      }
    })();

    return inflightLoad;
  },

  upsertSession: (session) => {
    set((state) => {
      const nextActiveSessions = upsertSessionIntoList(state.activeSessions, session);

      if (nextActiveSessions === state.activeSessions) {
        return state;
      }

      return {
        activeSessions: nextActiveSessions,
        sessionsByDirectory: buildSessionsByDirectory(nextActiveSessions),
      };
    });
  },

  removeSessions: (ids) => {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    if (idSet.size === 0) {
      return;
    }

    set((state) => {
      const nextActiveSessions = state.activeSessions.filter((session) => !idSet.has(session.id));

      if (nextActiveSessions.length === state.activeSessions.length) {
        return state;
      }

      return {
        activeSessions: nextActiveSessions,
        sessionsByDirectory: buildSessionsByDirectory(nextActiveSessions),
      };
    });
  },

}));

export const ensureGlobalSessionsLoaded = async (fallbackActive?: Session[]): Promise<LoadResult> => {
  const state = useGlobalSessionsStore.getState();
  if (state.hasLoaded && state.status !== 'error') {
    return { activeSessions: state.activeSessions };
  }
  return state.loadSessions(fallbackActive);
};

export const refreshGlobalSessions = async (fallbackActive?: Session[]): Promise<LoadResult> => {
  return useGlobalSessionsStore.getState().loadSessions(fallbackActive);
};
