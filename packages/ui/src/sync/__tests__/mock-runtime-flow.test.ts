import { describe, expect, it } from 'bun:test'
import { createMockClaudeRuntime } from '@/lib/claude/mockRuntime'
import type { ClaudeEvent, ClaudeEventsPush } from '@/lib/claude/protocol'
import { createClaudeEventSource } from '../claude-event-source'
import { applyDirectoryEvent } from '../event-reducer'
import { INITIAL_STATE, type State } from '../types'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check: () => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await wait(20)
  }
}

describe('mock Claude runtime -> event source -> reducer', () => {
  it('plays a scripted turn through permission and question prompts to a finished turn', async () => {
    const runtime = createMockClaudeRuntime()
    const state: State = structuredClone(INITIAL_STATE)
    const seen: ClaudeEvent[] = []

    const source = createClaudeEventSource({
      subscribe: (listener) => runtime.subscribe(listener as (push: ClaudeEventsPush) => void),
      onEvents: (events) => {
        for (const event of events) {
          seen.push(event)
          applyDirectoryEvent(state, event)
        }
      },
      onGap: () => {
        throw new Error('unexpected gap')
      },
    })

    const bootstrap = await runtime.request('claude:bootstrap', {})
    source.setBaseline(bootstrap.eventSeq)
    expect(bootstrap.catalog.models.length).toBeGreaterThan(0)

    const session = await runtime.request('claude:session.create', { title: 'Demo' })
    await runtime.request('claude:session.setMode', { sessionId: session.id, mode: 'default' })
    const { messageId } = await runtime.request('claude:session.send', { sessionId: session.id, text: 'Add a name parameter' })

    // Permission prompt for the edit tool.
    await waitFor(() => (state.permission[session.id]?.length ?? 0) > 0)
    const permission = state.permission[session.id][0]
    expect(permission.permission).toBe('edit')
    await runtime.request('claude:permission.respond', { sessionId: session.id, requestId: permission.id, response: 'once' })

    // Question prompt after the todo update.
    await waitFor(() => (state.question[session.id]?.length ?? 0) > 0)
    expect(state.todo[session.id]).toHaveLength(2)
    const question = state.question[session.id][0]
    await runtime.request('claude:question.respond', { sessionId: session.id, requestId: question.id, answers: [['Casual']] })

    await waitFor(() => state.session_status[session.id]?.type === 'idle' && (state.message[session.id]?.length ?? 0) === 2)
    source.cleanup()

    const [user, assistant] = state.message[session.id] as unknown as Array<Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(user.id).toBe(messageId)
    expect(user.role).toBe('user')
    expect(assistant.role).toBe('assistant')
    expect(assistant.finish).toBe('end_turn')
    expect(assistant.tokens.output).toBeGreaterThan(0)
    expect(user.id < assistant.id).toBe(true)

    const parts = state.part[assistant.id as string] as unknown as Array<Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(parts.map((part) => part.type)).toEqual(['reasoning', 'text', 'tool', 'tool', 'text'])
    expect(parts[1].text).toBe("I'll update the greeting helper so it accepts an optional name.\n\n")
    const edit = parts.find((part) => part.type === 'tool' && part.tool === 'edit')
    expect(edit?.state.status).toBe('completed')
    expect(edit?.state.metadata.filediff.additions).toBe(2)
    expect(parts[parts.length - 1].text).toContain('casual')
    expect(state.permission[session.id]).toHaveLength(0)
    expect(state.question[session.id]).toHaveLength(0)

    // Snapshot reload returns the same finished state.
    const snapshot = await runtime.request('claude:session.load', { sessionId: session.id })
    expect(snapshot.messages).toHaveLength(2)
    expect(snapshot.status.type).toBe('idle')
    expect(seen.some((event) => event.type === 'permission.replied')).toBe(true)
  }, 20000)

  it('marks the running tool as rejected when the permission is denied', async () => {
    const runtime = createMockClaudeRuntime()
    const state: State = structuredClone(INITIAL_STATE)
    const source = createClaudeEventSource({
      subscribe: (listener) => runtime.subscribe(listener as (push: ClaudeEventsPush) => void),
      onEvents: (events) => events.forEach((event) => applyDirectoryEvent(state, event)),
      onGap: () => undefined,
    })
    source.setBaseline((await runtime.request('claude:bootstrap', {})).eventSeq)

    const session = await runtime.request('claude:session.create', {})
    await runtime.request('claude:session.setMode', { sessionId: session.id, mode: 'default' })
    await runtime.request('claude:session.send', { sessionId: session.id, text: 'go' })
    await waitFor(() => (state.permission[session.id]?.length ?? 0) > 0)
    await runtime.request('claude:permission.respond', {
      sessionId: session.id,
      requestId: state.permission[session.id][0].id,
      response: 'reject',
    })
    await waitFor(() => (state.question[session.id]?.length ?? 0) > 0)

    const assistant = state.message[session.id][1]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const edit = (state.part[assistant.id] as unknown as Array<Record<string, any>>).find((part) => part.type === 'tool' && part.tool === 'edit')
    expect(edit?.state.status).toBe('error')

    await runtime.request('claude:session.interrupt', { sessionId: session.id })
    await waitFor(() => state.session_status[session.id]?.type === 'idle')
    source.cleanup()
  }, 20000)

  it('exposes plugin primary agents and records the selected main agent on the user message', async () => {
    const runtime = createMockClaudeRuntime()
    const bootstrap = await runtime.request('claude:bootstrap', {})
    expect(bootstrap.catalog.primaryAgents.map((agent) => agent.name)).toEqual([
      'claudekei:orchestrator',
      'claudekei:planner',
      'claudekei:sprinter',
      'claudekei:business-analyst',
    ])
    expect(bootstrap.catalog.defaults.agent).toBe('claudekei:orchestrator')

    const session = await runtime.request('claude:session.create', {})
    await runtime.request('claude:session.setAgent', { sessionId: session.id, agent: 'claudekei:planner' })
    await runtime.request('claude:session.send', { sessionId: session.id, text: 'plan it' })
    const snapshot = await runtime.request('claude:session.load', { sessionId: session.id })
    expect((snapshot.messages[0] as { agent: string }).agent).toBe('claudekei:planner')

    await runtime.request('claude:session.send', { sessionId: session.id, text: 'again', agent: 'claudekei:sprinter' })
    const next = await runtime.request('claude:session.load', { sessionId: session.id })
    expect((next.messages.filter((m) => m.role === 'user')[1] as { agent: string }).agent).toBe('claudekei:sprinter')
    await runtime.request('claude:session.interrupt', { sessionId: session.id })
  })

  it('plan_exit approval switches the session mode (always -> acceptEdits) and rejection keeps planning', async () => {
    const runtime = createMockClaudeRuntime()
    const state: State = structuredClone(INITIAL_STATE)
    const source = createClaudeEventSource({
      subscribe: (listener) => runtime.subscribe(listener as (push: ClaudeEventsPush) => void),
      onEvents: (events) => events.forEach((event) => applyDirectoryEvent(state, event)),
      onGap: () => undefined,
    })
    source.setBaseline((await runtime.request('claude:bootstrap', {})).eventSeq)

    const session = await runtime.request('claude:session.create', {})
    await runtime.request('claude:session.send', { sessionId: session.id, text: '[mock:plan] design it' })
    await waitFor(() => (state.permission[session.id]?.length ?? 0) > 0)
    const request = state.permission[session.id][0]
    expect(request.permission).toBe('plan_exit')
    expect(String(request.metadata.plan)).toContain('## Plan')
    expect(state.session.find((s) => s.id === session.id)?.mode).toBe('plan')

    await runtime.request('claude:permission.respond', { sessionId: session.id, requestId: request.id, response: 'always' })
    await waitFor(() => state.session_status[session.id]?.type === 'idle' && state.session.find((s) => s.id === session.id)?.mode === 'acceptEdits')

    await runtime.request('claude:session.setMode', { sessionId: session.id, mode: 'plan' })
    await waitFor(() => state.session.find((s) => s.id === session.id)?.mode === 'plan')
    source.cleanup()
  }, 20000)

  it('offers no always suggestions for the bash permission scenario', async () => {
    const runtime = createMockClaudeRuntime()
    const state: State = structuredClone(INITIAL_STATE)
    const source = createClaudeEventSource({
      subscribe: (listener) => runtime.subscribe(listener as (push: ClaudeEventsPush) => void),
      onEvents: (events) => events.forEach((event) => applyDirectoryEvent(state, event)),
      onGap: () => undefined,
    })
    source.setBaseline((await runtime.request('claude:bootstrap', {})).eventSeq)
    const session = await runtime.request('claude:session.create', {})
    await runtime.request('claude:session.setMode', { sessionId: session.id, mode: 'default' })
    await runtime.request('claude:session.send', { sessionId: session.id, text: '[mock:bash]' })
    await waitFor(() => (state.permission[session.id]?.length ?? 0) > 0)
    expect(state.permission[session.id][0].always).toEqual([])
    await runtime.request('claude:session.interrupt', { sessionId: session.id })
    source.cleanup()
  }, 20000)

  it('emits auth and hook session errors with their kinds', async () => {
    const runtime = createMockClaudeRuntime()
    const kinds: string[] = []
    runtime.subscribe((push) => {
      for (const event of push.events) {
        if (event.type === 'session.error') kinds.push(String(event.properties.error.kind))
      }
    })
    const session = await runtime.request('claude:session.create', {})
    await runtime.request('claude:session.send', { sessionId: session.id, text: '[mock:auth]' })
    await runtime.request('claude:session.send', { sessionId: session.id, text: '[mock:hook]' })
    await waitFor(() => kinds.length >= 2)
    expect(kinds).toEqual(['auth', 'hook'])
  })

  it('[mock:subagents] spawns parallel subagents with child sessions, resumes one via SendMessage and fails one', async () => {
    const runtime = createMockClaudeRuntime()
    const state: State = structuredClone(INITIAL_STATE)
    const source = createClaudeEventSource({
      subscribe: (listener) => runtime.subscribe(listener as (push: ClaudeEventsPush) => void),
      onEvents: (events) => events.forEach((event) => applyDirectoryEvent(state, event)),
      onGap: () => undefined,
    })
    source.setBaseline((await runtime.request('claude:bootstrap', {})).eventSeq)

    const session = await runtime.request('claude:session.create', {})
    await runtime.request('claude:session.send', { sessionId: session.id, text: 'fan out [mock:subagents]' })

    // Three child sessions appear while the first assistant message is still running.
    await waitFor(() => state.session.filter((candidate) => candidate.parentID === session.id).length === 3)
    const children = state.session.filter((candidate) => candidate.parentID === session.id)
    expect(children.map((child) => child.claude?.alias).sort()).toEqual(['dbg-1', 'exp-1', 'lib-1'])
    expect(children.every((child) => child.id.startsWith('sub_'))).toBe(true)

    await waitFor(() => state.session_status[session.id]?.type === 'idle' && (state.message[session.id]?.length ?? 0) === 4, 30000)
    source.cleanup()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parentParts = (state.message[session.id] as unknown as Array<Record<string, any>>)
      .filter((message) => message.role === 'assistant')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .flatMap((message) => state.part[message.id] as unknown as Array<Record<string, any>>)
    const agentParts = parentParts.filter((part) => part.type === 'tool' && part.tool === 'task')
    expect(agentParts).toHaveLength(3)
    expect(agentParts.map((part) => part.state.metadata.runStatus).sort()).toEqual(['completed', 'completed', 'error'])
    expect(agentParts.every((part) => part.state.metadata.sessionID.startsWith('sub_'))).toBe(true)

    const sendParts = parentParts.filter((part) => part.type === 'tool' && part.tool === 'sendmessage')
    expect(sendParts.map((part) => part.state.status).sort()).toEqual(['completed', 'error'])
    expect(sendParts.find((part) => part.state.status === 'completed')?.state.metadata.runStatus).toBe('completed')
    expect(parentParts.find((part) => part.tool === 'ToolSearch')?.state.metadata.hidden).toBe(true)

    // The resumed subagent has an initial and a follow-up instruction; every child ends idle with no progress.
    const exp = children.find((child) => child.claude?.alias === 'exp-1')!
    const expUsers = (state.message[exp.id] as unknown as Array<{ role: string; instruction?: { kind: string; index: number } }>).filter((m) => m.role === 'user')
    expect(expUsers.map((m) => [m.instruction?.kind, m.instruction?.index])).toEqual([['initial', 1], ['followup', 2]])
    for (const child of children) {
      expect(state.session_status[child.id]?.type).toBe('idle')
      expect(state.session.find((candidate) => candidate.id === child.id)?.claude?.progress).toBeUndefined()
    }
  }, 40000)

  it('model/effort: catalog defaults, per-agent defaults applied on setAgent, setEffort/setModel and resolvedModel on send', async () => {
    const runtime = createMockClaudeRuntime()
    const bootstrap = await runtime.request('claude:bootstrap', {})
    expect(bootstrap.catalog.defaults.mode).toBe('bypassPermissions')
    expect(bootstrap.catalog.primaryAgents.find((agent) => agent.name === 'claudekei:planner')).toMatchObject({ defaultModel: 'opus', defaultEffort: 'max' })
    expect(bootstrap.catalog.models.find((model) => model.value === 'haiku')?.supportsEffort).toBe(false)

    const session = await runtime.request('claude:session.create', {})
    expect(session).toMatchObject({ mode: 'bypassPermissions', agent: 'claudekei:orchestrator', model: 'opus', effort: 'high' })
    expect(session.resolvedModel).toBeUndefined()

    // Switching agent applies the agent's defaults at once (host emits session.updated).
    await runtime.request('claude:session.setAgent', { sessionId: session.id, agent: 'claudekei:sprinter' })
    let loaded = await runtime.request('claude:session.load', { sessionId: session.id })
    expect(loaded.session).toMatchObject({ agent: 'claudekei:sprinter', model: 'sonnet', effort: 'low' })

    await runtime.request('claude:session.setEffort', { sessionId: session.id, effort: 'medium' })
    await runtime.request('claude:session.setModel', { sessionId: session.id, model: 'opus' })
    loaded = await runtime.request('claude:session.load', { sessionId: session.id })
    expect(loaded.session).toMatchObject({ model: 'opus', effort: 'medium' })
    await runtime.request('claude:session.setEffort', { sessionId: session.id, effort: null })
    loaded = await runtime.request('claude:session.load', { sessionId: session.id })
    expect(loaded.session.effort).toBeUndefined()

    // The concrete model becomes known when the session is (re)spawned by a send; send can carry model + effort.
    await runtime.request('claude:session.send', { sessionId: session.id, text: 'hi [mock:bash]', model: 'sonnet', effort: 'high' })
    loaded = await runtime.request('claude:session.load', { sessionId: session.id })
    expect(loaded.session).toMatchObject({ model: 'sonnet', effort: 'high', resolvedModel: 'claude-sonnet-4-5-20250929' })
    await runtime.request('claude:session.interrupt', { sessionId: session.id })
  })

  it('bypassPermissions skips tool permission prompts', async () => {
    const runtime = createMockClaudeRuntime()
    const state: State = structuredClone(INITIAL_STATE)
    const source = createClaudeEventSource({
      subscribe: (listener) => runtime.subscribe(listener as (push: ClaudeEventsPush) => void),
      onEvents: (events) => events.forEach((event) => applyDirectoryEvent(state, event)),
      onGap: () => undefined,
    })
    source.setBaseline((await runtime.request('claude:bootstrap', {})).eventSeq)
    const session = await runtime.request('claude:session.create', {})
    await runtime.request('claude:session.send', { sessionId: session.id, text: 'go [mock:bash]' })
    await waitFor(() => state.session_status[session.id]?.type === 'idle' && (state.message[session.id]?.length ?? 0) === 2)
    expect(state.permission[session.id] ?? []).toHaveLength(0)
    source.cleanup()
  }, 20000)

  it('context usage and plan limits: bootstrap usage, session.contextUsage after a turn, usage.refresh pushes usage.updated', async () => {
    const runtime = createMockClaudeRuntime()
    const pushes: ClaudeEventsPush[] = []
    runtime.subscribe((push) => pushes.push(push as ClaudeEventsPush))
    const bootstrap = await runtime.request('claude:bootstrap', {})
    expect(bootstrap.usage?.plan).toBe('Team')
    expect(bootstrap.usage?.windows.map((window) => window.id)).toEqual(['session', 'weekly', 'weekly:fable'])

    const session = await runtime.request('claude:session.create', {})
    expect(session.contextUsage).toBeUndefined()
    await runtime.request('claude:session.send', { sessionId: session.id, text: 'hi [mock:bash]' })
    await waitFor(() => pushes.some((push) => push.events.some((event) => event.type === 'session.updated' && (event.properties.info as { contextUsage?: unknown }).contextUsage !== undefined)))

    const context = await runtime.request('claude:session.contextUsage', { sessionId: session.id })
    expect(context.maxTokens).toBe(1_000_000)
    expect(context.source).toBe('exact')
    expect(context.categories.find((category) => category.id === 'messages')?.kind).toBe('used')
    expect(context.categories.find((category) => category.id === 'autocompact-buffer')?.kind).toBe('buffer')
    expect(context.categories.some((category) => category.kind === 'deferred')).toBe(true)
    const used = context.categories.filter((category) => category.kind === 'used').reduce((sum, category) => sum + category.tokens, 0)
    expect(used).toBe(context.usedTokens)

    const usage = await runtime.request('claude:usage.refresh', {})
    expect(usage.windows).toHaveLength(3)
    await waitFor(() => pushes.some((push) => push.events.some((event) => event.type === 'usage.updated')))
    await runtime.request('claude:session.interrupt', { sessionId: session.id })
  })
})
