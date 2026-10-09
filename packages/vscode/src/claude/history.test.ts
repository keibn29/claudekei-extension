import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@openchamber/ui/src/lib/claude/types';
import { loadHistory, replayEntries, type HistoryEntry, type HistorySdk } from './history';
import { allToolParts, creationOrderIds, fakeClock, loadJson, loadNdjson, runFixture } from './testUtils';
import { bucketFor, type SessionBucket, type SessionState } from './sessionState';

/** Child buckets of a replayed state. */
const childrenOf = (state: SessionState, mainId: string) => [...state.sessions.entries()].filter(([id]) => id !== mainId).map(([id, b]) => ({ id, bucket: b }));

const opts = (sessionId: string, cwd: string) => ({ sessionId, cwd, mode: 'default' as const, model: 'haiku' });

/** Fixtures whose `history-<name>.json` was recorded from the same session (multi-turn/compact differ, see below). */
const EQUIVALENT = ['edit', 'edit-parallel', 'write', 'read', 'bash', 'grep', 'todowrite', 'thinking', 'askuserquestion', 'permission-denied', 'interrupt', 'task', 'task-sync'];

/** Comparable essence of a bucket: structure and content, not ids/times/usage. */
function essence(bucket: SessionBucket): unknown {
  return bucket.messages.map((m: Message) => {
    const parts = (bucket.parts[m.id] ?? []).map((p: Part) => {
      switch (p.type) {
        case 'text':
        case 'reasoning':
          return { type: p.type, text: p.text, ...(p.type === 'text' && p.synthetic ? { synthetic: true } : {}) };
        case 'file':
          return { type: p.type, mime: p.mime, url: p.url };
        case 'tool': {
          const s = p.state as any;
          const diff = s.metadata?.filediff;
          return {
            type: 'tool',
            tool: p.tool,
            callID: p.callID,
            claude: p.claude,
            status: s.status,
            input: s.input,
            title: s.title,
            output: s.output,
            error: s.error,
            ...(diff ? { diffStats: [diff.file, diff.additions, diff.deletions] } : {}),
          };
        }
        default:
          return { type: p.type };
      }
    });
    return m.role === 'user'
      ? { role: 'user', uuid: m.claudeUuid, parts }
      : { role: 'assistant', api: (m as any).apiMessageId, model: (m as any).modelID, parts, error: (m as any).error?.name };
  });
}

describe('live == history replay (final state)', () => {
  for (const name of EQUIVALENT) {
    test(name, () => {
      const live = runFixture(name);
      const entries = loadJson<HistoryEntry[]>(`history-${name}.json`);
      const init = loadNdjson(name).find((l) => l.subtype === 'init')!;
      const replayed = replayEntries(entries, { ...opts(live.sessionId, init.cwd), now: fakeClock() });

      expect(essence(replayed.state.sessions.get(live.sessionId)!)).toEqual(essence(live.main));
      expect(bucketFor(replayed.state, live.sessionId).todos).toEqual(live.main.todos);

      // replay never leaves a tool pending/running, ids ascend
      for (const t of allToolParts(replayed.state)) expect(['completed', 'error']).toContain(t.state.status);
      const order = creationOrderIds(replayed.events);
      expect([...order].sort()).toEqual(order);
      // children from the Agent tool calls exist in both
      expect(childrenOf(replayed.state, live.sessionId).map((c) => c.id).sort()).toEqual([...live.state.sessions.keys()].filter((k) => k !== live.sessionId).sort());
      // replay emits no status events
      expect(replayed.events.some((e) => e.type === 'session.status')).toBe(false);
    });
  }

  test('multi-turn: the first two turns match (history also contains the later resume turn)', () => {
    const live = runFixture('multi-turn');
    const entries = loadJson<HistoryEntry[]>('history-multi-turn.json');
    const replayed = replayEntries(entries, { ...opts(live.sessionId, '/x'), now: fakeClock() });
    const a = essence(live.main) as unknown[];
    const b = (essence(replayed.state.sessions.get(live.sessionId)!) as unknown[]).slice(0, a.length);
    expect(b).toEqual(a);
    expect((essence(replayed.state.sessions.get(live.sessionId)!) as unknown[]).length).toBeGreaterThan(a.length);
  });

  test('compact: replay shows the compaction marker and the slash command', () => {
    const entries = loadJson<HistoryEntry[]>('history-compact.json');
    const replayed = replayEntries(entries, { ...opts('s', '/x'), now: fakeClock() });
    const e = essence(replayed.state.sessions.get('s')!) as any[];
    const texts = e.flatMap((m) => m.parts.filter((p: any) => p.type === 'text').map((p: any) => p.text));
    expect(texts).toContain('Context compacted');
    expect(texts).toContain('/compact');
    expect(texts.some((t: string) => t.includes('This session is being continued'))).toBe(false);
    expect(texts.some((t: string) => t.includes('local-command-stdout'))).toBe(false);
  });
});

describe('replay details', () => {
  test('ids derive from transcript timestamps and stay ascending', () => {
    const entries = loadJson<HistoryEntry[]>('history-edit.json');
    const replayed = replayEntries(entries, { ...opts('s', '/x'), now: fakeClock() });
    const first = Date.parse(entries[0]!.timestamp!);
    const messages = bucketFor(replayed.state, 's').messages;
    expect(messages[0]!.id.startsWith(String(first))).toBe(true);
    expect(messages[0]!.time.created).toBe(first);
  });

  test('subagent transcripts replay into the child session (getSubagentMessages)', async () => {
    const entries = loadJson<HistoryEntry[]>('history-task-sync.json');
    const probe = loadJson<any>('session-helpers-probe.json');
    const subMessages: HistoryEntry[] = probe.subagents.taskSync.messages;
    const calls: string[] = [];
    const sdk: HistorySdk = {
      getSessionMessages: async () => entries,
      listSubagents: async (id) => {
        calls.push(`list:${id}`);
        return ['agent-1'];
      },
      getSubagentMessages: async (id, agent) => {
        calls.push(`sub:${id}:${agent}`);
        return subMessages;
      },
    };
    const snap = await loadHistory({ ...opts('sess-1', '/x'), sdk, now: fakeClock() });
    expect(calls).toEqual(['list:sess-1', 'sub:sess-1:agent-1']);
    const kids = childrenOf(snap.state, 'sess-1');
    expect(kids).toHaveLength(1);
    const child = kids[0]!.bucket;
    expect(child.messages.map((m) => m.role as string)).toEqual(['user', 'assistant', 'assistant'].slice(0, child.messages.length));
    expect(child.messages.length).toBeGreaterThanOrEqual(2);
    const tools = allToolParts(snap.state).filter((t) => t.sessionID === kids[0]!.id);
    expect(tools.map((t) => [t.tool, t.state.status])).toEqual([['read', 'completed']]);
  });

  test('subagent loading can be disabled and failures are non-fatal', async () => {
    const entries = loadJson<HistoryEntry[]>('history-task-sync.json');
    const failing: HistorySdk = {
      getSessionMessages: async () => entries,
      listSubagents: async () => {
        throw new Error('boom');
      },
      getSubagentMessages: async () => [],
    };
    const warnings: string[] = [];
    const snap = await loadHistory({ ...opts('s', '/x'), sdk: failing, now: fakeClock(), log: (l, m) => l === 'warn' && warnings.push(m) });
    expect(bucketFor(snap.state, 's').messages.length).toBeGreaterThan(0);
    expect(warnings).toEqual(['could not load subagent history']);
    const off = await loadHistory({ ...opts('s', '/x'), sdk: failing, includeSubagents: false, now: fakeClock() });
    expect(bucketFor(off.state, 's').messages.length).toBeGreaterThan(0);
  });

  test('missing session yields an empty snapshot', async () => {
    const sdk: HistorySdk = { getSessionMessages: async () => [], listSubagents: async () => [], getSubagentMessages: async () => [] };
    const snap = await loadHistory({ ...opts('nope', '/x'), sdk });
    expect(bucketFor(snap.state, 'nope').messages).toEqual([]);
    expect(childrenOf(snap.state, 'nope')).toEqual([]);
  });

  test('tool outputs above the limit are truncated and flagged', () => {
    const big = 'x'.repeat(150_000);
    const entries: HistoryEntry[] = [
      { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'run' }] } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01.000Z', message: { id: 'msg_1', model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat big' } }] } },
      { type: 'user', uuid: 'u2', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: big }] } },
    ];
    const snap = replayEntries(entries, { ...opts('s', '/x'), now: fakeClock() });
    const bash = allToolParts(snap.state)[0]!;
    const state = bash.state as { output: string; metadata: Record<string, unknown> };
    expect(state.output.length).toBe(100 * 1024);
    expect(state.metadata.truncated).toBe(true);
  });

  test('a tool_use without a result is closed as an error (no pending tools in cold sessions)', () => {
    const entries: HistoryEntry[] = [
      { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'go' } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01.000Z', message: { id: 'msg_1', model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'x' } }] } },
    ];
    const snap = replayEntries(entries, { ...opts('s', '/x'), now: fakeClock() });
    expect(allToolParts(snap.state)[0]!.state.status).toBe('error');
  });

  test('system entries and malformed entries are skipped', () => {
    const snap = replayEntries([{ type: 'system', uuid: 's' }, { type: 'user', uuid: 'x' } as HistoryEntry], { ...opts('s', '/x') });
    expect(bucketFor(snap.state, 's').messages).toEqual([]);
  });
});
