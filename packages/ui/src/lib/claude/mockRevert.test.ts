import { describe, expect, it } from 'bun:test'
import { createMockClaudeRuntime } from './mockRuntime'
import type { ClaudeEvent, ClaudeEventsPush } from './protocol'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await wait(20)
  }
}

describe('mock runtime: revert / unrevert', () => {
  it('revert marks the session, a send commits it (messages removed in one batch), unrevert clears the marker', async () => {
    const runtime = createMockClaudeRuntime()
    const pushes: ClaudeEventsPush[] = []
    runtime.subscribe((push) => pushes.push(push as ClaudeEventsPush))
    const session = await runtime.request('claude:session.create', {})
    const idle = async () => (await runtime.request('claude:session.load', { sessionId: session.id })).status.type === 'idle'
    const load = () => runtime.request('claude:session.load', { sessionId: session.id })

    await runtime.request('claude:session.send', { sessionId: session.id, text: '[mock:hook] first' })
    await waitFor(idle)
    await runtime.request('claude:session.send', { sessionId: session.id, text: '[mock:hook] second' })
    await waitFor(idle)
    const users = (await load()).messages.filter((m) => m.role === 'user')
    expect(users).toHaveLength(2)
    expect(users.every((m) => m.role === 'user' && typeof m.claudeUuid === 'string')).toBe(true)

    expect(await runtime.request('claude:session.revertPreview', { sessionId: session.id, messageId: users[1]!.id })).toEqual({ files: [], insertions: 0, deletions: 0 })
    expect(await runtime.request('claude:session.revert', { sessionId: session.id, messageId: users[1]!.id })).toEqual({ files: [] })
    await waitFor(idle)
    const reverted = await load()
    expect(reverted.session.revert).toEqual({ messageID: users[1]!.id })
    expect(reverted.messages.some((m) => m.id === users[1]!.id)).toBe(true) // hidden by the UI, still in the host state

    await runtime.request('claude:session.unrevert', { sessionId: session.id })
    expect((await load()).session.revert).toBeUndefined()

    await runtime.request('claude:session.revert', { sessionId: session.id, messageId: users[1]!.id })
    await waitFor(idle)
    pushes.length = 0
    await runtime.request('claude:session.send', { sessionId: session.id, text: '[mock:hook] third' })
    await wait(10)
    const batch = pushes.find((p) => p.events.some((e: ClaudeEvent) => e.type === 'message.removed'))!
    const removed = batch.events.filter((e) => e.type === 'message.removed').map((e) => (e as { properties: { messageID: string } }).properties.messageID)
    expect(removed).toContain(users[1]!.id)
    expect(batch.events.some((e) => e.type === 'session.updated' && !e.properties.info.revert)).toBe(true)
    expect(batch.events.some((e) => e.type === 'message.updated' && e.properties.info.role === 'user')).toBe(true)
    await waitFor(idle)
    const after = await load()
    expect(after.session.revert).toBeUndefined()
    expect(after.messages.filter((m) => m.role === 'user').map((m) => m.id)).not.toContain(users[1]!.id)
    expect(after.messages.filter((m) => m.role === 'user')).toHaveLength(2) // first + third
  }, 30000)
})
