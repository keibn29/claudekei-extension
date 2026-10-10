import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import React from 'react';
import type { Session } from '@/lib/claude/types';

// Install minimal hook dispatcher for headless unit testing of useSessionActions
const testDispatcher = {
  useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}],
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useContext: () => ({ t: (key: string) => key }),
};

const internals = (React as unknown as Record<string, { H?: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const previousDispatcher = internals ? internals.H : null;

beforeAll(() => {
  if (internals) {
    internals.H = testDispatcher;
  }
});

afterAll(() => {
  if (internals && previousDispatcher !== null) {
    internals.H = previousDispatcher;
  }
});

let consoleErrorSpy: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  if (consoleErrorSpy) {
    consoleErrorSpy.mockRestore();
    consoleErrorSpy = null;
  }
});

import { useSessionActions } from './useSessionActions';

// Test harness to invoke useSessionActions without full React DOM rendering
function useActionsHarness(options: {
  showDeletionDialog?: boolean;
  childrenMap?: Map<string, Session[]>;
}) {
  const deleteSessionCalls: string[] = [];
  const deleteSessionsCalls: string[][] = [];
  let confirmState: { session: Session; descendantCount: number } | null = null;

  const mockDeleteSession = mock(async (id: string) => {
    deleteSessionCalls.push(id);
    return true;
  });

  const mockDeleteSessions = mock(async (ids: string[]) => {
    deleteSessionsCalls.push(ids);
    return { deletedIds: ids, failedIds: [] };
  });

  const args: Parameters<typeof useSessionActions>[0] = {
    activeProjectId: null,
    currentDirectory: '/test/dir',
    currentSessionId: null,
    mobileVariant: false,
    allowReselect: false,
    isSessionSearchOpen: false,
    sessionSearchQuery: '',
    setSessionSearchQuery: () => {},
    setIsSessionSearchOpen: () => {},
    setActiveProjectIdOnly: () => {},
    setDirectory: () => {},
    setActiveMainTab: () => {},
    setSessionSwitcherOpen: () => {},
    setCurrentSession: () => {},
    updateSessionTitle: async () => {},
    deleteSession: mockDeleteSession,
    deleteSessions: mockDeleteSessions,
    childrenMap: options.childrenMap ?? new Map(),
    showDeletionDialog: options.showDeletionDialog ?? true,
    setDeleteSessionConfirm: (val) => {
      confirmState = typeof val === 'function' ? (val as (prev: typeof confirmState) => typeof confirmState)(confirmState) : val;
      args.deleteSessionConfirm = confirmState;
    },
    deleteSessionConfirm: confirmState,
    setEditingId: () => {},
    setEditTitle: () => {},
    editingId: null,
    editTitle: '',
  };

  const actions = useSessionActions(args);

  return {
    actions,
    args,
    getConfirmState: () => confirmState,
    deleteSessionCalls,
    deleteSessionsCalls,
  };
}

describe('useSessionActions - session deletion', () => {
  const parentSession: Session = { id: 'parent-1', title: 'Parent Task' } as Session;
  const childSession: Session = { id: 'child-1', parentID: 'parent-1', title: 'Subtask' } as Session;

  const childrenMap = new Map<string, Session[]>([
    ['parent-1', [childSession]],
  ]);

  test('handleDeleteSession deletes children first, then the parent', async () => {
    const harness = useActionsHarness({
      showDeletionDialog: false,
      childrenMap,
    });

    harness.actions.handleDeleteSession(parentSession);

    // Wait for microtask tick
    await new Promise((r) => setTimeout(r, 10));

    expect(harness.deleteSessionsCalls.length).toBe(1);
    expect(harness.deleteSessionsCalls[0]).toEqual(['child-1', 'parent-1']);
    expect(harness.deleteSessionCalls.length).toBe(0);
  });

  test('Confirmation dialog flow: dialog state is set and children-first delete runs on confirm', async () => {
    const harness = useActionsHarness({
      showDeletionDialog: true,
      childrenMap,
    });

    harness.actions.handleDeleteSession(parentSession);

    // Dialog state is set with descendantCount: 1
    const confirm = harness.getConfirmState();
    expect(confirm !== null).toBe(true);
    expect(confirm?.session.id).toBe('parent-1');
    expect(confirm?.descendantCount).toBe(1);

    // If user cancels: confirmState is set to null, no delete occurs
    harness.args.setDeleteSessionConfirm(null);
    expect(harness.getConfirmState()).toBe(null);
    expect(harness.deleteSessionsCalls.length).toBe(0);

    // If user re-opens and confirms:
    harness.actions.handleDeleteSession(parentSession);
    await harness.actions.confirmDeleteSession();

    expect(harness.deleteSessionsCalls.length).toBe(1);
    expect(harness.deleteSessionsCalls[0]).toEqual(['child-1', 'parent-1']);
  });

  test('Single session without descendants calls deleteSession directly', async () => {
    const harness = useActionsHarness({
      showDeletionDialog: false,
      childrenMap: new Map(), // No children
    });

    const standaloneSession: Session = { id: 'single-1', title: 'Single' } as Session;
    harness.actions.handleDeleteSession(standaloneSession);

    await new Promise((r) => setTimeout(r, 10));

    expect(harness.deleteSessionCalls).toEqual(['single-1']);
    expect(harness.deleteSessionsCalls.length).toBe(0);
  });
});
