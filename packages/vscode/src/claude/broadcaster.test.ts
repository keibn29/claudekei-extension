import { describe, expect, test } from 'bun:test';
import type { ClaudeEvent, ClaudeEventsPush } from '@openchamber/ui/src/lib/claude/protocol';
import { Broadcaster, coalesceEvents } from './broadcaster';
import { ManualTimers } from './fakes';

const delta = (partID: string, d: string, sessionID = 's', messageID = 'm'): ClaudeEvent => ({ type: 'message.part.delta', properties: { sessionID, messageID, partID, field: 'text', delta: d } });
const part = (id: string, text = ''): ClaudeEvent => ({ type: 'message.part.updated', properties: { part: { id, sessionID: 's', messageID: 'm', type: 'text', text } } });
const status = (type: 'busy' | 'idle'): ClaudeEvent => ({ type: 'session.status', properties: { sessionID: 's', status: { type } } });

describe('coalesceEvents', () => {
  test('merges consecutive deltas of the same part, keeps different parts apart', () => {
    const out = coalesceEvents([delta('p1', 'a'), delta('p2', 'x'), delta('p1', 'b'), delta('p1', 'c')]);
    expect(out).toHaveLength(2);
    expect((out[0] as any).properties.delta).toBe('abc');
    expect((out[1] as any).properties.delta).toBe('x');
  });

  test('a part update of the same part is a barrier', () => {
    const out = coalesceEvents([delta('p1', 'a'), part('p1', 'ab'), delta('p1', 'c')]);
    expect(out.map((e) => e.type)).toEqual(['message.part.delta', 'message.part.updated', 'message.part.delta']);
    expect((out[2] as any).properties.delta).toBe('c');
  });

  test('other events are untouched and ordered', () => {
    const out = coalesceEvents([status('busy'), delta('p1', 'a'), status('idle')]);
    expect(out.map((e) => e.type)).toEqual(['session.status', 'message.part.delta', 'session.status']);
  });
});

describe('Broadcaster', () => {
  const make = () => {
    const timers = new ManualTimers();
    const b = new Broadcaster({ setTimer: timers.setTimeout, clearTimer: timers.clearTimeout, batchMs: 16 });
    const a: ClaudeEventsPush[] = [];
    const c: ClaudeEventsPush[] = [];
    const sa = b.register({ post: (m) => a.push(m) });
    const sc = b.register({ post: (m) => c.push(m) });
    return { timers, b, a, c, sa, sc };
  };

  test('batches within 16 ms into one push with seq 1, then 2', () => {
    const { timers, b, a } = make();
    b.emit([delta('p1', 'a')]);
    b.emit([delta('p1', 'b'), status('busy')]);
    expect(a).toHaveLength(0);
    timers.advance(15);
    expect(a).toHaveLength(0);
    timers.advance(2);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ type: 'claude:events', seq: 1 });
    expect(a[0]!.events).toHaveLength(2);
    expect((a[0]!.events[0] as any).properties.delta).toBe('ab');
    b.emit([status('idle')]);
    timers.advance(20);
    expect(a.map((p) => p.seq)).toEqual([1, 2]);
  });

  test('seq is per webview; unregistered webviews stop receiving', () => {
    const { timers, b, a, c, sa } = make();
    b.emit([status('busy')]);
    timers.advance(20);
    sa.dispose();
    b.emit([status('idle')]);
    timers.advance(20);
    expect(a.map((p) => p.seq)).toEqual([1]);
    expect(c.map((p) => p.seq)).toEqual([1, 2]);
  });

  test('flush() sends immediately; empty emit does nothing; sink errors do not break others', () => {
    const timers = new ManualTimers();
    const errors: string[] = [];
    const b = new Broadcaster({ setTimer: timers.setTimeout, clearTimer: timers.clearTimeout, onSinkError: (id) => errors.push(id) });
    const ok: ClaudeEventsPush[] = [];
    b.register({ post: () => { throw new Error('disposed'); } });
    b.register({ post: (m) => ok.push(m) });
    b.emit([]);
    expect(timers.pending).toBe(0);
    b.emit([status('busy')]);
    b.flush();
    expect(ok).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  test('flushSink pushes that webview\'s pending events first and reports its seq; others stay queued', () => {
    const { timers, b, a, c, sa } = make();
    b.emit([status('busy')]);
    timers.advance(20); // seq 1 for both
    b.emit([delta('p1', 'x', 's1')]);
    expect(b.flushSink(sa.id)).toBe(2);
    expect(a.map((p) => p.seq)).toEqual([1, 2]);
    expect(c).toHaveLength(1); // the other webview still waits for the batch timer
    timers.advance(20);
    expect(c.map((p) => p.seq)).toEqual([1, 2]);
    expect(a).toHaveLength(2); // nothing is sent twice
    expect(b.flushSink(sa.id)).toBe(2); // nothing pending: seq unchanged
    expect(b.flushSink('nope')).toBe(0);
  });
});
