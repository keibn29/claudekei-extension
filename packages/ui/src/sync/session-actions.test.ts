import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'

// ---------------------------------------------------------------------------
// Mocks — session-actions only talks to claudeClient and a few stores.
// ---------------------------------------------------------------------------

type Call = { fn: string; args: unknown[] }
const calls: Call[] = []
const record = (fn: string, result?: unknown) => (...args: unknown[]) => {
  calls.push({ fn, args })
  return Promise.resolve(result)
}

let failDeleteFor = new Set<string>()
const toasts: string[] = []

// Real modules are restored in `afterAll` (mock.module is process-wide in bun).
const realClientModule = { ...(await import('@/lib/claude/client')) }
afterAll(() => {
  mock.module('@/lib/claude/client', () => realClientModule)
})
mock.module('@/lib/claude/client', () => ({
  claudeClient: {
    createSession: record('createSession', {
      id: 'new-session',
      title: 'New session',
      directory: '/work',
      time: { created: 1, updated: 1 },
    }),
    deleteSession: (id: string) => {
      calls.push({ fn: 'deleteSession', args: [id] })
      return failDeleteFor.has(id) ? Promise.reject(new Error('boom')) : Promise.resolve()
    },
    renameSession: record('renameSession'),
    interrupt: record('interrupt'),
    respondPermission: record('respondPermission'),
    respondQuestion: record('respondQuestion'),
    fork: record('fork', { id: 'forked', title: 'Fork', directory: '/work', time: { created: 2, updated: 2 } }),
  },
}))

const uiState = {
  currentSessionId: null as string | null,
  setCurrentSession: (id: string | null) => {
    uiState.currentSessionId = id
  },
  markSessionAsOpenChamberCreated: () => {},
}
mock.module('./session-ui-store', () => ({ useSessionUIStore: { getState: () => uiState } }))
mock.module('./input-store', () => ({
  useInputStore: { setState: (patch: unknown) => calls.push({ fn: 'inputStore.setState', args: [patch] }) },
}))
mock.module('@/stores/useGlobalSessionsStore', () => ({
  useGlobalSessionsStore: {
    getState: () => ({
      upsertSession: () => {},
      removeSessions: (ids: Set<string>) => calls.push({ fn: 'global.removeSessions', args: [Array.from(ids)] }),
      loadSessions: () => Promise.resolve(),
    }),
  },
}))
// Keep the real module around: mock.module is process-wide, so other test files get it back in `afterAll`.
const realConfigStoreModule = { ...(await import('@/stores/useConfigStore')) }
afterAll(() => {
  mock.module('@/stores/useConfigStore', () => realConfigStoreModule)
})
mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      isConnected: true,
      hasEverConnected: true,
      lastDisconnectReason: null,
      probeConnection: () => Promise.resolve(true),
    }),
  },
}))
// mock.module is process-wide in bun: expose the full toast surface so other test files keep working.
const noopToast = () => undefined
mock.module('sonner', () => ({
  Toaster: () => null,
  toast: {
    info: (message: string) => toasts.push(message),
    success: noopToast,
    error: noopToast,
    warning: noopToast,
    message: noopToast,
    loading: noopToast,
    dismiss: noopToast,
    promise: noopToast,
  },
}))

const sessionActions = await import('./session-actions')
const { ChildStoreManager } = await import('./child-store')

const session = (id: string, parentID?: string) => ({
  id,
  title: id,
  directory: '/work',
  ...(parentID ? { parentID } : {}),
  time: { created: 1, updated: 1 },
})

function setup() {
  const childStores = new ChildStoreManager()
  childStores.configure({ onBootstrap: () => {} })
  const store = childStores.ensureChild('/work', { bootstrap: false })
  store.setState({
    session: [session('a'), session('b'), session('sub_toolu1', 'a')],
    message: { a: [{ id: 'm1', sessionID: 'a', role: 'user', time: { created: 1 }, agent: 'default', model: { providerID: 'anthropic', modelID: 'sonnet' } }] },
    part: { m1: [{ id: 'p1', sessionID: 'a', messageID: 'm1', type: 'text', text: 'hello' }] },
  })
  sessionActions.setActionRefs(childStores, () => '/work')
  return { store }
}

beforeEach(() => {
  calls.length = 0
  toasts.length = 0
  failDeleteFor = new Set()
  uiState.currentSessionId = null
})

describe('permissions and questions', () => {
  it('forwards permission replies to the host', async () => {
    setup()
    await sessionActions.respondToPermission('a', 'perm-1', 'always')
    await sessionActions.dismissPermission('a', 'perm-2')
    expect(calls.filter((c) => c.fn === 'respondPermission').map((c) => c.args)).toEqual([
      ['a', 'perm-1', 'always'],
      ['a', 'perm-2', 'reject'],
    ])
  })

  it('wraps flat question answers and supports rejection', async () => {
    setup()
    await sessionActions.respondToQuestion('a', 'q-1', ['Casual'])
    await sessionActions.respondToQuestion('a', 'q-2', [['Formal'], ['x', 'y']])
    await sessionActions.rejectQuestion('a', 'q-3')
    expect(calls.filter((c) => c.fn === 'respondQuestion').map((c) => c.args)).toEqual([
      ['a', 'q-1', [['Casual']]],
      ['a', 'q-2', [['Formal'], ['x', 'y']]],
      ['a', 'q-3', { reject: true }],
    ])
  })
})

describe('abort', () => {
  it('interrupts the session', async () => {
    setup()
    await sessionActions.abortCurrentOperation('a')
    expect(calls).toContainEqual({ fn: 'interrupt', args: ['a'] })
  })
})

describe('createSession', () => {
  it('creates a draft on the host, inserts it into the store and opens it', async () => {
    const { store } = setup()
    const created = await sessionActions.createSession('Hello')
    expect(created?.id).toBe('new-session')
    expect(calls).toContainEqual({ fn: 'createSession', args: ['Hello'] })
    expect(store.getState().session.map((s) => s.id)).toContain('new-session')
    expect(uiState.currentSessionId).toBe('new-session')
  })
})

describe('deleteSessions', () => {
  it('deletes root sessions on the host, removes subagent children locally and clears caches', async () => {
    const { store } = setup()
    uiState.currentSessionId = 'a'

    const result = await sessionActions.deleteSessions(['a'])

    expect(calls.filter((c) => c.fn === 'deleteSession').map((c) => c.args[0])).toEqual(['a'])
    expect(result.deletedIds.sort()).toEqual(['a', 'sub_toolu1'])
    expect(result.failedIds).toEqual([])
    expect(store.getState().session.map((s) => s.id)).toEqual(['b'])
    expect(store.getState().message.a).toBeUndefined()
    expect(store.getState().part.m1).toBeUndefined()
    expect(uiState.currentSessionId).toBeNull()
  })

  it('reports host failures', async () => {
    setup()
    failDeleteFor = new Set(['b'])
    const result = await sessionActions.deleteSessions(['b'])
    expect(result.failedIds).toEqual(['b'])
    expect(result.deletedIds).toEqual([])
  })
})

describe('updateSessionTitle', () => {
  it('renames on the host and updates the store immediately', async () => {
    const { store } = setup()
    await sessionActions.updateSessionTitle('a', 'Renamed')
    expect(calls).toContainEqual({ fn: 'renameSession', args: ['a', 'Renamed'] })
    expect(store.getState().session.find((s) => s.id === 'a')?.title).toBe('Renamed')
  })
})

describe('fork', () => {
  it('forking from a user message opens the draft fork and restores that message text', async () => {
    const { store } = setup()
    await sessionActions.forkFromMessage('a', 'm1')
    expect(calls).toContainEqual({ fn: 'fork', args: ['a', 'm1'] })
    expect(store.getState().session.map((s) => s.id)).toContain('forked')
    expect(uiState.currentSessionId).toBe('forked')
    expect(calls).toContainEqual({
      fn: 'inputStore.setState',
      args: [{ pendingInputText: 'hello', pendingInputMode: 'replace' }],
    })
  })

  it('forking from an assistant message does not pre-fill the composer', async () => {
    const { store } = setup()
    store.setState({
      message: {
        ...store.getState().message,
        a: [
          ...store.getState().message.a,
          { id: 'm2', sessionID: 'a', role: 'assistant', parentID: 'm1', time: { created: 2 }, modelID: 'x', providerID: 'anthropic', tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 },
        ],
      },
      part: { ...store.getState().part, m2: [{ id: 'p2', sessionID: 'a', messageID: 'm2', type: 'text', text: 'answer' }] },
    })
    await sessionActions.forkFromMessage('a', 'm2')
    expect(calls).toContainEqual({ fn: 'fork', args: ['a', 'm2'] })
    expect(calls.filter((c) => c.fn === 'inputStore.setState')).toHaveLength(0)
  })
})

describe('Phase 2 stubs', () => {
  it('shows a toast instead of archiving, sharing or reverting', async () => {
    setup()
    expect(await sessionActions.archiveSession('a')).toBe(false)
    expect(await sessionActions.shareSession('a')).toBeNull()
    expect(await sessionActions.unshareSession('a')).toBeNull()
    await sessionActions.revertToMessage('a', 'm1')
    await sessionActions.unrevertSession('a')
    expect(toasts).toHaveLength(5)
    expect(calls.filter((c) => c.fn === 'deleteSession')).toHaveLength(0)
  })
})
