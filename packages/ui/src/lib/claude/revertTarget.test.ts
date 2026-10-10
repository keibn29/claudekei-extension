import { describe, expect, it } from 'bun:test'
import { isRevertTargetMessage } from './revertTarget'
import type { Message } from './types'

const user = (extra: Record<string, unknown> = {}): Message =>
  ({
    id: 'm1',
    sessionID: 's1',
    role: 'user',
    time: { created: 1 },
    agent: 'default',
    model: { providerID: 'anthropic', modelID: 'sonnet' },
    claudeUuid: 'uuid-1',
    ...extra,
  }) as Message

describe('revert target predicate', () => {
  it('accepts a main-session user message with a claudeUuid', () => {
    expect(isRevertTargetMessage(user(), 's1')).toBe(true)
  })

  it('rejects messages without claudeUuid', () => {
    expect(isRevertTargetMessage(user({ claudeUuid: undefined }), 's1')).toBe(false)
  })

  it('rejects subagent instruction messages', () => {
    expect(isRevertTargetMessage(user({ instruction: { toolUseId: 't1' } }), 's1')).toBe(false)
  })

  it('rejects messages in child sessions', () => {
    expect(isRevertTargetMessage(user(), 'sub_toolu1')).toBe(false)
  })

  it('rejects assistant messages', () => {
    const assistant = { ...user(), role: 'assistant' } as Message
    expect(isRevertTargetMessage(assistant, 's1')).toBe(false)
  })
})
