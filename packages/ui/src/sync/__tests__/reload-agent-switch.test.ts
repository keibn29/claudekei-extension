import { describe, expect, it } from 'bun:test'
import type { StoreApi } from 'zustand'
import { createMockClaudeRuntime } from '@/lib/claude/mockRuntime'
import {
  deriveAgentSwitchDividers,
  derivePendingAgentSwitch,
  findLatestUserAgent,
  hasUserMessage,
  planHostAdoption,
} from '@/lib/claude/agentSwitch'
import { applySessionSnapshot } from '../session-snapshot'
import type { DirectoryStore } from '../child-store'
import { INITIAL_STATE, type State } from '../types'

/** A fresh store, like the webview after "Developer: Reload Window", fed only by `claude:session.load`. */
const freshStore = (): StoreApi<DirectoryStore> => {
  let state = structuredClone(INITIAL_STATE) as State
  return {
    getState: () => state as unknown as DirectoryStore,
    setState: (partial: unknown) => {
      const next = typeof partial === 'function' ? (partial as (s: State) => Partial<State>)(state) : (partial as Partial<State>)
      state = { ...state, ...next }
    },
    subscribe: () => () => undefined,
    getInitialState: () => state as unknown as DirectoryStore,
  } as unknown as StoreApi<DirectoryStore>
}

const waitIdle = async (runtime: ReturnType<typeof createMockClaudeRuntime>, sessionId: string) => {
  const deadline = Date.now() + 8000
  for (;;) {
    const snapshot = await runtime.request('claude:session.load', { sessionId })
    if (snapshot.status.type === 'idle' && snapshot.messages.some((message) => message.role === 'assistant')) return snapshot
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('reload: composer agent and switch divider come from the replayed session', () => {
  it('derives the dividers, the applied agent and the adopted agent from a fresh store fed by session.load', async () => {
    const runtime = createMockClaudeRuntime()
    const session = await runtime.request('claude:session.create', {})
    // Orchestrator message, then switch to Planner and send again (pending until the send).
    await runtime.request('claude:session.send', { sessionId: session.id, text: 'first [mock:bash]' })
    await waitIdle(runtime, session.id)
    await runtime.request('claude:session.setAgent', { sessionId: session.id, agent: 'claudekei:planner' })
    await runtime.request('claude:session.send', { sessionId: session.id, text: 'second [mock:bash]', agent: 'claudekei:planner' })
    const snapshot = await (async () => {
      const deadline = Date.now() + 8000
      for (;;) {
        const loaded = await runtime.request('claude:session.load', { sessionId: session.id })
        if (loaded.status.type === 'idle' && loaded.messages.filter((m) => m.role === 'assistant').length === 2) return loaded
        if (Date.now() > deadline) throw new Error('timed out')
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    })()

    // "Reload": nothing survives except what the host returns.
    const store = freshStore()
    applySessionSnapshot(store, snapshot)
    const state = store.getState() as unknown as State
    const messages = state.message[session.id]
    const hostSession = state.session.find((candidate) => candidate.id === session.id)!

    // The divider derivation only needs the replayed messages.
    const users = messages.filter((message) => message.role === 'user')
    expect(users.map((message) => (message as { agent: string }).agent)).toEqual(['claudekei:orchestrator', 'claudekei:planner'])
    const dividers = deriveAgentSwitchDividers(users.map((message) => ({ id: message.id, agent: (message as { agent: string }).agent })))
    expect([...dividers.values()]).toEqual([{ from: 'claudekei:orchestrator', to: 'claudekei:planner' }])
    expect(dividers.has(users[1].id)).toBe(true)

    // The composer adopts Session.agent (not the catalog default) on the first value it sees after the reload.
    expect(hostSession.agent).toBe('claudekei:planner')
    const plan = planHostAdoption({
      previous: { sessionId: null },
      sessionId: session.id,
      hostAgent: hostSession.agent,
      hostModel: hostSession.model,
      knownAgents: ['claudekei:orchestrator', 'claudekei:planner'],
      knownModels: ['default', 'opus', 'sonnet', 'haiku'],
    })
    expect(plan.agent).toBe('claudekei:planner')

    // Nothing is pending: the applied agent (last user message) equals the selected one.
    expect(hasUserMessage(messages)).toBe(true)
    expect(findLatestUserAgent(messages)).toBe('claudekei:planner')
    expect(derivePendingAgentSwitch({ sessionStarted: true, selectedAgent: hostSession.agent, appliedAgent: findLatestUserAgent(messages), busy: false }).pending).toBe(false)
  }, 30000)

  it('a pending switch (host updated Session.agent, no message sent yet) survives the reload as pending', async () => {
    const runtime = createMockClaudeRuntime()
    const session = await runtime.request('claude:session.create', {})
    await runtime.request('claude:session.send', { sessionId: session.id, text: 'hello [mock:bash]' })
    await waitIdle(runtime, session.id)
    await runtime.request('claude:session.setAgent', { sessionId: session.id, agent: 'claudekei:sprinter' })

    const store = freshStore()
    applySessionSnapshot(store, await runtime.request('claude:session.load', { sessionId: session.id }))
    const state = store.getState() as unknown as State
    const hostSession = state.session.find((candidate) => candidate.id === session.id)!
    const messages = state.message[session.id]

    const pending = derivePendingAgentSwitch({
      sessionStarted: hasUserMessage(messages),
      selectedAgent: hostSession.agent,
      appliedAgent: findLatestUserAgent(messages),
      busy: false,
    })
    expect(pending).toMatchObject({ pending: true, from: 'claudekei:orchestrator', to: 'claudekei:sprinter' })
  }, 30000)

  it('regression: cold load with Session.agent=planner and replayed user agents [sprinter x4, planner] shows Planner and the divider', () => {
    const sessionId = 'sess-reload'
    const agents = ['claudekei:sprinter', 'claudekei:sprinter', 'claudekei:sprinter', 'claudekei:sprinter', 'claudekei:planner']
    const model = { providerID: 'anthropic' as const, modelID: 'opus' }
    const messages = agents.map((agent, index) => ({
      id: `message_${String(index).padStart(4, '0')}`,
      sessionID: sessionId,
      role: 'user' as const,
      time: { created: 1000 + index },
      agent,
      model,
    }))
    const snapshot = {
      session: { id: sessionId, title: 't', directory: '/w', time: { created: 1, updated: 2 }, agent: 'claudekei:planner', mode: 'bypassPermissions' as const, model: 'opus' },
      messages,
      parts: {},
      status: { type: 'idle' as const },
      permissions: [],
      questions: [],
      todos: [],
      children: [],
    }

    // Fresh store (reload), fed only by the snapshot.
    const store = freshStore()
    applySessionSnapshot(store, snapshot)
    const state = store.getState() as unknown as State
    const hostSession = state.session.find((candidate) => candidate.id === sessionId)!
    const replayed = state.message[sessionId]

    // Composer: the first host value for the session is adopted (not the catalog default orchestrator).
    const plan = planHostAdoption({
      previous: { sessionId: null },
      sessionId,
      hostAgent: hostSession.agent,
      hostModel: hostSession.model,
      knownAgents: ['claudekei:orchestrator', 'claudekei:planner', 'claudekei:sprinter'],
      knownModels: ['default', 'opus'],
    })
    expect(plan.agent).toBe('claudekei:planner')

    // Divider: derived from the replayed messages only (no live-only state), exactly once, above the Planner message.
    const dividers = deriveAgentSwitchDividers(replayed.map((message) => ({ id: message.id, agent: (message as { agent?: string }).agent })))
    expect([...dividers.entries()]).toEqual([[replayed[4].id, { from: 'claudekei:sprinter', to: 'claudekei:planner' }]])

    // The applied agent equals the selected one, so nothing is pending.
    expect(derivePendingAgentSwitch({ sessionStarted: true, selectedAgent: hostSession.agent, appliedAgent: findLatestUserAgent(replayed), busy: false }).pending).toBe(false)
  })
})
