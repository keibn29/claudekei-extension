import { describe, expect, it } from 'bun:test'
import { applyDirectoryEvent } from '../event-reducer'
import { INITIAL_STATE } from '../types'

describe('applyDirectoryEvent', () => {
  it('does not duplicate overlapping delta text after a newer part.updated replaces an older one', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-1'
    const partID = 'part-1'

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: 'Fix typo in ToolOutputDialog — ',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: 'Fix typo in ToolOutputDialog — toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it.',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: 'toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it.',
      },
    })

    expect(state.part[messageID]).toHaveLength(1)
    expect(state.part[messageID]?.[0]?.text).toBe(
      'Fix typo in ToolOutputDialog — toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it.',
    )
  })

  it('appends only the non-overlapping suffix of a streaming delta', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-2'
    const partID = 'part-2'

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: 'toolFailedToReadDiagram vs toolFailedRead',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: 'toolFailedToReadDiagram vs toolFailedReadDiagra',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: 'Diagram • Let me fix it.',
      },
    })

    expect(state.part[messageID]?.[0]?.text).toBe(
      'toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it.',
    )
  })

  it('appends a non-overlapping delta unchanged', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-3'
    const partID = 'part-3'

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: 'PR comment done — ',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: 'Let me fix it.',
      },
    })

    expect(state.part[messageID]?.[0]?.text).toBe('PR comment done — Let me fix it.')
  })

  it('preserves legitimate repeated output when no updated-to-delta dedupe window is active', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-4'
    const partID = 'part-4'

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: 'ha',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: 'ha',
      },
    })

    expect(state.part[messageID]?.[0]?.text).toBe('haha')
  })

  it('does not let a stale running tool update overwrite a completed tool part', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-5'
    const partID = 'part-5'

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'tool',
          messageID,
          tool: 'apply_patch',
          state: {
            status: 'completed',
            time: {
              start: 10,
              end: 20,
            },
          },
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'tool',
          messageID,
          tool: 'apply_patch',
          state: {
            status: 'running',
            time: {
              start: 10,
            },
          },
        },
      },
    })

    expect(state.part[messageID]?.[0]?.state?.status).toBe('completed')
    expect(state.part[messageID]?.[0]?.state?.time?.end).toBe(20)
  })

  it('re-renders an assistant message when only tokens, cost or error change', () => {
    const state = structuredClone(INITIAL_STATE)
    const base = {
      id: 'msg-u', sessionID: 's1', role: 'assistant', parentID: 'msg-p',
      time: { created: 1 }, modelID: 'sonnet', providerID: 'anthropic',
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0,
    }
    expect(applyDirectoryEvent(state, { type: 'message.updated', properties: { sessionID: 's1', info: base } })).toBe(true)

    // Identical update: nothing changed.
    expect(applyDirectoryEvent(state, { type: 'message.updated', properties: { sessionID: 's1', info: { ...base } } })).toBe(false)

    const withTokens = { ...base, tokens: { ...base.tokens, output: 12 } }
    expect(applyDirectoryEvent(state, { type: 'message.updated', properties: { sessionID: 's1', info: withTokens } })).toBe(true)
    expect(state.message.s1[0].tokens.output).toBe(12)

    const withCost = { ...withTokens, cost: 0.5 }
    expect(applyDirectoryEvent(state, { type: 'message.updated', properties: { sessionID: 's1', info: withCost } })).toBe(true)

    const withError = { ...withCost, error: { name: 'APIError', message: 'boom' } }
    expect(applyDirectoryEvent(state, { type: 'message.updated', properties: { sessionID: 's1', info: withError } })).toBe(true)
    expect(state.message.s1[0].error.message).toBe('boom')
  })

  it('evicts the least recently updated session when over the limit, keeping sessions with pending permissions', () => {
    const state = structuredClone(INITIAL_STATE)
    state.limit = 2
    const make = (id, updated) => ({ id, title: id, directory: '/w', time: { created: updated, updated } })

    applyDirectoryEvent(state, { type: 'session.created', properties: { sessionID: 'a', info: make('a', 300) } })
    applyDirectoryEvent(state, { type: 'session.created', properties: { sessionID: 'b', info: make('b', 100) } })
    // 'b' is oldest by time.updated although 'c' sorts last by id.
    applyDirectoryEvent(state, { type: 'session.created', properties: { sessionID: 'c', info: make('c', 200) } })
    expect(state.session.map((s) => s.id)).toEqual(['a', 'c'])

    state.permission = { a: [{ id: 'p1', sessionID: 'a', permission: 'edit', patterns: [], metadata: {}, always: [] }] }
    applyDirectoryEvent(state, { type: 'session.created', properties: { sessionID: 'd', info: make('d', 400) } })
    // 'a' is the oldest but has a pending permission, so 'c' goes instead.
    expect(state.session.map((s) => s.id)).toEqual(['a', 'd'])
  })

  it('stores todos and session status and clears status to idle on session.error', () => {
    const state = structuredClone(INITIAL_STATE)
    const todos = [{ id: 't1', content: 'x', status: 'in_progress', priority: 'medium' }]
    applyDirectoryEvent(state, { type: 'todo.updated', properties: { sessionID: 's1', todos } })
    expect(state.todo.s1).toEqual(todos)

    applyDirectoryEvent(state, { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
    expect(state.session_status.s1.type).toBe('busy')

    expect(applyDirectoryEvent(state, { type: 'session.error', properties: { sessionID: 's1', error: { name: 'x', message: 'y' } } })).toBe(true)
    expect(state.session_status.s1.type).toBe('idle')
    expect(applyDirectoryEvent(state, { type: 'session.error', properties: { error: { name: 'x', message: 'y' } } })).toBe(false)
  })

  it('tracks permission and question requests until they are answered', () => {
    const state = structuredClone(INITIAL_STATE)
    const permission = { id: 'perm-1', sessionID: 's1', permission: 'bash', patterns: ['ls'], metadata: {}, always: [] }
    applyDirectoryEvent(state, { type: 'permission.asked', properties: permission })
    expect(state.permission.s1).toHaveLength(1)
    applyDirectoryEvent(state, { type: 'permission.replied', properties: { sessionID: 's1', requestID: 'perm-1', reply: 'once' } })
    expect(state.permission.s1).toHaveLength(0)

    const question = { id: 'q-1', sessionID: 's1', questions: [{ question: 'Pick', header: 'H', options: [] }] }
    applyDirectoryEvent(state, { type: 'question.asked', properties: question })
    expect(state.question.s1).toHaveLength(1)
    applyDirectoryEvent(state, { type: 'question.rejected', properties: { sessionID: 's1', requestID: 'q-1' } })
    expect(state.question.s1).toHaveLength(0)
  })

  it('rebuilds agents, commands and provider from catalog.updated', () => {
    const state = structuredClone(INITIAL_STATE)
    const catalog = {
      models: [{ value: 'sonnet', displayName: 'Sonnet', description: '' }],
      commands: [{ name: 'compact', description: 'c', argumentHint: '' }],
      agents: [{ name: 'Explore', description: 'e' }],
      primaryAgents: [{ name: 'claudekei:planner', displayName: 'Planner', color: 'blue', description: 'p' }],
      defaults: { model: 'sonnet', mode: 'default', agent: 'claudekei:planner' },
    }
    expect(applyDirectoryEvent(state, { type: 'catalog.updated', properties: { catalog } })).toBe(true)
    expect(state.provider.all[0].id).toBe('anthropic')
    expect(state.provider.default.anthropic).toBe('sonnet')
    expect(state.agent.map((a) => a.name)).toEqual(['claudekei:planner', 'Explore'])
    expect(state.command[0].name).toBe('compact')
    expect(applyDirectoryEvent(state, { type: 'account.updated', properties: { account: null } })).toBe(false)
  })

  describe('copy-on-write (selectors compare by reference)', () => {
    const perm = (id) => ({ id, sessionID: 's1', permission: 'edit', patterns: [], metadata: {}, always: [] })
    const question = (id) => ({ id, sessionID: 's1', questions: [{ question: 'Q', header: 'H', options: [] }] })

    it('replaces the per-session permission array on asked and replied', () => {
      const state = structuredClone(INITIAL_STATE)
      applyDirectoryEvent(state, { type: 'permission.asked', properties: perm('p1') })
      const afterFirst = state.permission.s1
      const record = state.permission

      applyDirectoryEvent(state, { type: 'permission.asked', properties: perm('p2') })
      expect(state.permission).not.toBe(record)
      expect(state.permission.s1).not.toBe(afterFirst)
      expect(afterFirst).toHaveLength(1)
      expect(state.permission.s1).toHaveLength(2)

      const beforeReply = state.permission.s1
      applyDirectoryEvent(state, { type: 'permission.replied', properties: { sessionID: 's1', requestID: 'p1', reply: 'once' } })
      expect(state.permission.s1).not.toBe(beforeReply)
      expect(beforeReply).toHaveLength(2)
      expect(state.permission.s1.map((p) => p.id)).toEqual(['p2'])
    })

    it('replaces the per-session question array on asked, replied and rejected', () => {
      const state = structuredClone(INITIAL_STATE)
      applyDirectoryEvent(state, { type: 'question.asked', properties: question('q1') })
      const first = state.question.s1
      applyDirectoryEvent(state, { type: 'question.asked', properties: question('q2') })
      expect(state.question.s1).not.toBe(first)
      expect(first).toHaveLength(1)

      const beforeReplied = state.question.s1
      applyDirectoryEvent(state, { type: 'question.replied', properties: { sessionID: 's1', requestID: 'q1', answers: [['x']] } })
      expect(state.question.s1).not.toBe(beforeReplied)
      expect(beforeReplied).toHaveLength(2)

      const beforeRejected = state.question.s1
      applyDirectoryEvent(state, { type: 'question.rejected', properties: { sessionID: 's1', requestID: 'q2' } })
      expect(state.question.s1).not.toBe(beforeRejected)
      expect(beforeRejected).toHaveLength(1)
      expect(state.question.s1).toHaveLength(0)
    })

    it('never mutates the slices of the state it was given (todos, status, messages, parts, sessions)', () => {
      const state = structuredClone(INITIAL_STATE)
      const snapshot = {
        todo: state.todo,
        status: state.session_status,
        message: state.message,
        part: state.part,
        session: state.session,
      }

      applyDirectoryEvent(state, { type: 'todo.updated', properties: { sessionID: 's1', todos: [] } })
      applyDirectoryEvent(state, { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
      applyDirectoryEvent(state, {
        type: 'message.updated',
        properties: { sessionID: 's1', info: { id: 'm1', sessionID: 's1', role: 'user', time: { created: 1 }, agent: 'a', model: { providerID: 'anthropic', modelID: 'x' } } },
      })
      applyDirectoryEvent(state, { type: 'message.part.updated', properties: { part: { id: 'p1', sessionID: 's1', messageID: 'm1', type: 'text', text: 'hi' } } })
      applyDirectoryEvent(state, { type: 'session.created', properties: { sessionID: 's1', info: { id: 's1', title: 't', directory: '/w', time: { created: 1, updated: 1 } } } })

      expect(snapshot.todo).toEqual({})
      expect(snapshot.status).toEqual({})
      expect(snapshot.message).toEqual({})
      expect(snapshot.part).toEqual({})
      expect(snapshot.session).toEqual([])
      expect(state.todo).not.toBe(snapshot.todo)
      expect(state.session_status).not.toBe(snapshot.status)
      expect(state.message).not.toBe(snapshot.message)
      expect(state.part).not.toBe(snapshot.part)
      expect(state.session).not.toBe(snapshot.session)
    })

    it('does not mutate caches shared with the previous state when a session is deleted', () => {
      const state = structuredClone(INITIAL_STATE)
      const info = { id: 's1', title: 't', directory: '/w', time: { created: 1, updated: 1 } }
      applyDirectoryEvent(state, { type: 'session.created', properties: { sessionID: 's1', info } })
      applyDirectoryEvent(state, { type: 'question.asked', properties: question('q1') })
      applyDirectoryEvent(state, { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
      applyDirectoryEvent(state, { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm1', sessionID: 's1', role: 'user', time: { created: 1 }, agent: 'a', model: { providerID: 'anthropic', modelID: 'x' } } } })
      const before = { question: state.question, status: state.session_status, message: state.message, session: state.session }

      applyDirectoryEvent(state, { type: 'session.deleted', properties: { sessionID: 's1', info } })

      expect(before.question.s1).toHaveLength(1)
      expect(before.status.s1.type).toBe('busy')
      expect(before.message.s1).toHaveLength(1)
      expect(before.session).toHaveLength(1)
      expect(state.question.s1).toBeUndefined()
      expect(state.session_status.s1).toBeUndefined()
      expect(state.message.s1).toBeUndefined()
      expect(state.session).toHaveLength(0)
    })
  })
})
