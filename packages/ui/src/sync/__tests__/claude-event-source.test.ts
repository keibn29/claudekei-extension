import { describe, expect, it } from 'bun:test'
import { createClaudeEventSource } from '../claude-event-source'
import type { ClaudeEvent, ClaudeEventsPush } from '@/lib/claude/protocol'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const status = (sessionID: string, type: 'idle' | 'busy'): ClaudeEvent => ({
  type: 'session.status',
  properties: { sessionID, status: { type } },
})

const delta = (delta: string): ClaudeEvent => ({
  type: 'message.part.delta',
  properties: { sessionID: 's', messageID: 'm', partID: 'p', field: 'text', delta },
})

function setup(options?: { onGap?: () => Promise<number | void> | number | void }) {
  let listener: ((push: ClaudeEventsPush) => void) | null = null
  const batches: ClaudeEvent[][] = []
  let gaps = 0
  const source = createClaudeEventSource({
    subscribe: (next) => {
      listener = next
      return () => {
        listener = null
      }
    },
    onEvents: (events) => batches.push(events),
    onGap: async () => {
      gaps += 1
      return options?.onGap ? options.onGap() : undefined
    },
  })
  const push = (seq: number, events: ClaudeEvent[]) => listener?.({ type: 'claude:events', seq, events })
  return { source, batches, push, gaps: () => gaps, subscribed: () => listener !== null }
}

describe('createClaudeEventSource', () => {
  it('buffers pushes until the baseline is known, then drops duplicates already in the snapshot', async () => {
    const { source, batches, push } = setup()
    push(4, [status('a', 'busy')])
    push(5, [status('b', 'busy')])
    source.setBaseline(4)
    await wait(60)

    const events = batches.flat()
    expect(events).toHaveLength(1)
    expect((events[0] as { properties: { sessionID: string } }).properties.sessionID).toBe('b')
    source.cleanup()
  })

  it('applies consecutive pushes in order and coalesces deltas of the same part', async () => {
    const { source, batches, push } = setup()
    source.setBaseline(0)
    push(1, [delta('Hel')])
    push(2, [delta('lo'), status('a', 'busy')])
    await wait(60)

    const events = batches.flat()
    const deltas = events.filter((event) => event.type === 'message.part.delta')
    expect(deltas).toHaveLength(1)
    expect((deltas[0] as { properties: { delta: string } }).properties.delta).toBe('Hello')
    source.cleanup()
  })

  it('keeps only the latest session.status of the same type per session', async () => {
    const { source, batches, push } = setup()
    source.setBaseline(0)
    const retry = (attempt: number): ClaudeEvent => ({ type: 'session.status', properties: { sessionID: 'a', status: { type: 'retry', attempt, message: 'm', next: 1 } } })
    push(1, [retry(1), retry(2)])
    await wait(60)

    const statuses = batches.flat().filter((event) => event.type === 'session.status')
    expect(statuses).toHaveLength(1)
    expect((statuses[0] as { properties: { status: { attempt: number } } }).properties.status.attempt).toBe(2)
    source.cleanup()
  })

  it('drops stale deltas once a full part update replaces the streamed text', async () => {
    const { source, batches, push } = setup()
    source.setBaseline(0)
    push(1, [
      {
        type: 'message.part.updated',
        properties: { part: { id: 'p', sessionID: 's', messageID: 'm', type: 'text', text: 'Hello' } },
      },
      delta('Hello'),
    ])
    await wait(60)

    // Delta arrived after the part snapshot in the same frame; the reducer dedupes overlap, so the
    // source must keep it (it only drops deltas that precede a coalesced part update).
    expect(batches.flat().map((event) => event.type)).toEqual(['message.part.updated', 'message.part.delta'])
    source.cleanup()
  })

  it('calls onGap on a missing seq and resumes from the reloaded baseline', async () => {
    const state = setup({ onGap: () => 10 })
    state.source.setBaseline(0)
    state.push(1, [status('a', 'busy')])
    state.push(3, [status('lost-gap', 'busy')]) // seq 2 never arrived
    await wait(20)
    expect(state.gaps()).toBe(1)

    // Reload resolved with baseline 10: seq 3 is stale, 11 continues.
    state.push(11, [status('after', 'busy')])
    await wait(60)

    const ids = state.batches.flat().map((event) => (event as { properties: { sessionID: string } }).properties.sessionID)
    expect(ids).toContain('a')
    expect(ids).toContain('after')
    expect(ids).not.toContain('lost-gap')
    state.source.cleanup()
  })

  it('unsubscribes on cleanup and flushes queued events', async () => {
    const { source, batches, push, subscribed } = setup()
    source.setBaseline(0)
    push(1, [status('a', 'busy')])
    source.cleanup()

    expect(subscribed()).toBe(false)
    expect(batches.flat()).toHaveLength(1)
  })

  it('keeps busy -> idle as two ordered events so turn-complete notifications still fire', async () => {
    const { source, batches, push } = setup()
    source.setBaseline(0)
    push(1, [status('a', 'busy')])
    push(2, [
      {
        type: 'message.updated',
        properties: { sessionID: 'a', info: { id: 'm', sessionID: 'a', role: 'user', time: { created: 1 }, agent: 'x', model: { providerID: 'anthropic', modelID: 'y' } } },
      },
      status('a', 'idle'),
    ])
    await wait(60)

    expect(batches.flat().map((event) => event.type)).toEqual(['session.status', 'message.updated', 'session.status'])
    const types = batches.flat().filter((e) => e.type === 'session.status').map((e) => (e as { properties: { status: { type: string } } }).properties.status.type)
    expect(types).toEqual(['busy', 'idle'])
    source.cleanup()
  })

  it('dropSessionEvents forgets queued events of that session up to the snapshot seq only', async () => {
    const { source, batches, push } = setup()
    source.setBaseline(0)
    push(1, [status('a', 'busy'), status('b', 'busy')])
    push(2, [delta('x')]) // session s
    // Snapshot of session "a" taken at seq 1 lands before the UI queue flushed.
    source.dropSessionEvents('a', 1)
    push(3, [status('a', 'idle')]) // newer than the snapshot: kept
    await wait(60)

    const ids = batches.flat().map((event) => `${event.type}:${(event as { properties: { sessionID: string } }).properties.sessionID}`)
    expect(ids).toEqual(['session.status:b', 'message.part.delta:s', 'session.status:a'])
    source.cleanup()
  })

  it('dropSessionEvents also trims events buffered while a resync is running', async () => {
    let finish: (seq: number) => void = () => undefined
    const state = setup({ onGap: () => new Promise<number>((resolve) => { finish = resolve }) })
    state.source.setBaseline(0)
    state.push(2, [status('a', 'busy')]) // gap: seq 1 missing -> resync starts, push is buffered
    state.push(3, [status('a', 'idle'), status('b', 'busy')])
    await wait(10)
    state.source.dropSessionEvents('a', 2)
    finish(1) // baseline 1 -> replays buffered pushes 2 and 3
    await wait(80)

    const ids = state.batches.flat().map((event) => `${(event as { properties: { sessionID: string } }).properties.sessionID}:${(event as { properties: { status: { type: string } } }).properties.status.type}`)
    expect(ids).toEqual(['a:idle', 'b:busy'])
    state.source.cleanup()
  })
})
