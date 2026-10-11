import { describe, expect, test } from 'bun:test';
import { revertedPromptIds, transcriptPaths, trimSubagents, type CutFs } from './subagentCut';

/** In-memory fs; `writes` lists the paths written (tmp + final) in order. */
const memFs = (files: Record<string, string>) => {
  const writes: string[] = [];
  const fs: CutFs = {
    readFile: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p]!;
    },
    writeFile: async (p, d) => void ((files[p] = d), writes.push(p)),
    rename: async (a, b) => void ((files[b] = files[a]!), delete files[a]),
    rm: async (p) => void delete files[p],
    readdir: async (p) => {
      const names = Object.keys(files).filter((f) => f.startsWith(`${p}/`) && !f.slice(p.length + 1).includes('/')).map((f) => f.slice(p.length + 1));
      if (!names.length) throw new Error('ENOENT');
      return names;
    },
  };
  return { files, writes, fs };
};

const jl = (...rows: Array<Record<string, unknown>>) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const user = (uuid: string, parentUuid: string | null, promptId: string | undefined, extra: Record<string, unknown> = {}) => ({ type: 'user', uuid, parentUuid, ...(promptId ? { promptId } : {}), isSidechain: true, ...extra });
const asst = (uuid: string, parentUuid: string | null) => ({ type: 'assistant', uuid, parentUuid, isSidechain: true });
const uuidsOf = (text: string) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l).uuid);

const DIR = '/p/s1/subagents';

describe('revertedPromptIds', () => {
  const main = jl(
    { type: 'agent-setting', agentSetting: 'x' },
    { type: 'user', uuid: 'u1', parentUuid: null, promptId: 'p1', isSidechain: false },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', promptId: 'p2', isSidechain: false },
    { type: 'user', uuid: 'r2', parentUuid: 'u2', promptId: 'p2', isSidechain: false },
    { type: 'user', uuid: 'side', parentUuid: null, promptId: 'sidechain-prompt', isSidechain: true },
    { type: 'user', uuid: 'u3', parentUuid: 'r2', promptId: 'p3', isSidechain: false },
  );

  test('the target turn and every later main-chain turn, once each; sidechain entries are ignored', async () => {
    const { fs } = memFs({ '/p/s1.jsonl': main });
    expect(await revertedPromptIds('/p/s1.jsonl', 'u2', fs)).toEqual(['p2', 'p3']);
    expect(await revertedPromptIds('/p/s1.jsonl', 'u1', fs)).toEqual(['p1', 'p2', 'p3']);
    expect(await revertedPromptIds('/p/s1.jsonl', 'u3', fs)).toEqual(['p3']);
  });

  test('a later main entry that reuses an earlier turn\'s promptId does not revert that turn (queued prompt injected under it)', async () => {
    const { fs } = memFs({
      '/p/s1.jsonl': jl(
        { type: 'user', uuid: 'u1', parentUuid: null, promptId: 'p1', isSidechain: false },
        { type: 'user', uuid: 'u2', parentUuid: 'u1', promptId: 'p2', isSidechain: false },
        { type: 'user', uuid: 'q', parentUuid: 'u2', promptId: 'p1', isSidechain: false }, // queued during turn 1, injected later
        { type: 'user', uuid: 'u3', parentUuid: 'q', promptId: 'p3', isSidechain: false },
      ),
    });
    expect(await revertedPromptIds('/p/s1.jsonl', 'u2', fs)).toEqual(['p2', 'p3']);
  });

  test('a missing transcript or target entry yields undefined; a target without promptId yields none', async () => {
    const { fs } = memFs({ '/p/s1.jsonl': main + jl({ type: 'user', uuid: 'old', parentUuid: null, isSidechain: false }) });
    expect(await revertedPromptIds('/p/none.jsonl', 'u2', fs)).toBeUndefined();
    expect(await revertedPromptIds('/p/s1.jsonl', 'ghost', fs)).toBeUndefined();
    expect(await revertedPromptIds('/p/s1.jsonl', 'old', fs)).toEqual([]);
  });
});

describe('trimSubagents', () => {
  test('transcriptPaths follows Claude Code\'s project directory naming', () => {
    expect(transcriptPaths({ home: '/h', cwd: '/Users/me/my proj', sessionId: 's1' })).toEqual({
      main: '/h/.claude/projects/-Users-me-my-proj/s1.jsonl',
      subagents: '/h/.claude/projects/-Users-me-my-proj/s1/subagents',
    });
  });

  test('drops the reverted continuation (a suffix): user lines by promptId, assistant lines by inheritance', async () => {
    const m = memFs({
      [`${DIR}/agent-A.jsonl`]: jl(user('a0', null, 'p1'), asst('a1', 'a0'), user('a2', 'a1', 'p1', { tool: 'result' }), asst('a3', 'a2'), user('a4', 'a3', 'p2'), asst('a5', 'a4'), asst('a6', 'a5')),
      [`${DIR}/agent-A.meta.json`]: '{}',
    });
    const r = await trimSubagents(DIR, ['p2'], m.fs);
    expect(r).toEqual({ removed: [], trimmed: ['A'], relinked: 0, failed: [] });
    expect(uuidsOf(m.files[`${DIR}/agent-A.jsonl`]!)).toEqual(['a0', 'a1', 'a2', 'a3']);
    expect(`${DIR}/agent-A.meta.json` in m.files).toBe(true);
    expect(m.writes.some((p) => p.endsWith('.tmp'))).toBe(true); // atomic: tmp + rename
    expect(Object.keys(m.files).some((p) => p.endsWith('.tmp'))).toBe(false);
  });

  test('a transcript that only ran in reverted turns is deleted together with its meta file', async () => {
    const m = memFs({
      [`${DIR}/agent-B.jsonl`]: jl(user('b0', null, 'p2'), asst('b1', 'b0')),
      [`${DIR}/agent-B.meta.json`]: '{"toolUseId":"t"}',
      [`${DIR}/agent-C.jsonl`]: jl(user('c0', null, 'p1'), asst('c1', 'c0')),
    });
    const r = await trimSubagents(DIR, ['p2'], m.fs);
    expect(r.removed).toEqual(['B']);
    expect(r.trimmed).toEqual([]);
    expect(Object.keys(m.files).sort()).toEqual([`${DIR}/agent-C.jsonl`]);
  });

  test('is idempotent and never matches turns of the new branch', async () => {
    const m = memFs({ [`${DIR}/agent-A.jsonl`]: jl(user('a0', null, 'p1'), asst('a1', 'a0'), user('a2', 'a1', 'p2'), asst('a3', 'a2')) });
    await trimSubagents(DIR, ['p2'], m.fs);
    // the new branch continues the agent under a fresh promptId p4
    m.files[`${DIR}/agent-A.jsonl`] += jl(user('n0', 'a1', 'p4'), asst('n1', 'n0'));
    m.writes.length = 0;
    const again = await trimSubagents(DIR, ['p2'], m.fs);
    expect(again).toEqual({ removed: [], trimmed: [], relinked: 0, failed: [] });
    expect(m.writes).toEqual([]); // nothing to drop: nothing written
    expect(uuidsOf(m.files[`${DIR}/agent-A.jsonl`]!)).toEqual(['a0', 'a1', 'n0', 'n1']);
  });

  test('entries without promptId: leading lines and metadata lines are kept, chain lines inherit the preceding turn', async () => {
    const m = memFs({
      [`${DIR}/agent-A.jsonl`]: jl(
        { type: 'attachment', uuid: 'x0', parentUuid: null, isSidechain: true }, // before any promptId: kept
        user('a0', 'x0', 'p1'),
        { type: 'ai-title', title: 't' }, // no uuid: metadata, never dropped
        user('a1', 'a0', 'p2'),
        { type: 'attachment', uuid: 'x1', parentUuid: 'a1', isSidechain: true }, // after a reverted user line: dropped
        { type: 'ai-title', title: 't2' },
      ),
    });
    await trimSubagents(DIR, ['p2'], m.fs);
    const kept = m.files[`${DIR}/agent-A.jsonl`]!.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(kept.map((e) => e.uuid ?? e.title)).toEqual(['x0', 'a0', 't', 't2']);
  });

  test('unparsable lines are kept before the first dropped line and dropped after it (truncated tail)', async () => {
    const m = memFs({ [`${DIR}/agent-A.jsonl`]: `${JSON.stringify(user('a0', null, 'p1'))}\nnot json\n${JSON.stringify(user('a1', 'a0', 'p2'))}\n{"type":"assis` });
    await trimSubagents(DIR, ['p2'], m.fs);
    expect(m.files[`${DIR}/agent-A.jsonl`]).toBe(`${JSON.stringify(user('a0', null, 'p1'))}\nnot json\n`);
  });

  test('dryRun reports what would change and writes nothing', async () => {
    const m = memFs({
      [`${DIR}/agent-A.jsonl`]: jl(user('a0', null, 'p1'), user('a1', 'a0', 'p2')),
      [`${DIR}/agent-B.jsonl`]: jl(user('b0', null, 'p2')),
    });
    const before = { ...m.files };
    const r = await trimSubagents(DIR, ['p2'], m.fs, { dryRun: true });
    expect(r).toMatchObject({ removed: ['B'], trimmed: ['A'] });
    expect(m.files).toEqual(before);
    expect(m.writes).toEqual([]);
  });

  test('structure of a real follow-up (hook attachments around it): the trimmed file ends at the SubagentStop attachment with an unbroken chain', async () => {
    // Modelled on a real agent transcript (original run under p1, follow-up under p2): content is anonymised.
    const att = (uuid: string, parent: string, hookEvent: string) => ({ type: 'attachment', uuid, parentUuid: parent, isSidechain: true, attachment: { type: 'hook_success', hookEvent } });
    const rows = [
      user('l1', null, 'p1'), // initial prompt
      att('l2', 'l1', 'SubagentStart'),
      asst('l3', 'l2'),
      att('l4', 'l3', 'PreToolUse'),
      user('l5', 'l3', 'p1', { sourceToolAssistantUUID: 'l3' }), // tool_result
      att('l6', 'l5', 'PostToolUse'),
      { type: 'attachment', uuid: 'l7', parentUuid: 'l6', isSidechain: true, attachment: { type: 'total_tokens_reminder' } },
      asst('l8', 'l7'), // end of the original run
      att('l9', 'l8', 'SubagentStop'), // <- last line that survives (line 75 of the real file)
      user('l10', 'l9', 'p2', { isMeta: true }), // follow-up from the reverted turn (line 76)
      att('l11', 'l10', 'SubagentStart'),
      { type: 'attachment', uuid: 'l12', parentUuid: 'l11', isSidechain: true, attachment: { type: 'date' } },
      asst('l13', 'l12'),
      att('l14', 'l13', 'PreToolUse'),
      user('l15', 'l13', 'p2', { sourceToolAssistantUUID: 'l13' }),
      att('l16', 'l15', 'PostToolUse'),
      asst('l17', 'l16'),
    ];
    const m = memFs({ [`${DIR}/agent-A.jsonl`]: jl(...rows) });
    await trimSubagents(DIR, ['p2'], m.fs);
    const kept = m.files[`${DIR}/agent-A.jsonl`]!.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { uuid: string; parentUuid: string | null });
    expect(kept.map((e) => e.uuid)).toEqual(['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9']);
    const ids = new Set(kept.map((e) => e.uuid));
    for (const e of kept) expect(e.parentUuid === null || ids.has(e.parentUuid)).toBe(true); // every parent is still there
    expect(kept.at(-1)!.parentUuid).toBe('l8');
  });

  test('dropped lines that are not a suffix: kept lines are re-pointed to their nearest kept ancestor', async () => {
    const m = memFs({ [`${DIR}/agent-A.jsonl`]: jl(user('a0', null, 'p1'), user('a1', 'a0', 'p2'), asst('a2', 'a1'), user('a3', 'a2', 'p1')) });
    const r = await trimSubagents(DIR, ['p2'], m.fs);
    expect(r.relinked).toBe(1);
    const kept = m.files[`${DIR}/agent-A.jsonl`]!.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(kept.map((e) => [e.uuid, e.parentUuid])).toEqual([['a0', null], ['a3', 'a0']]);
  });

  test('a failing file is reported and does not stop the others; a missing directory is fine', async () => {
    const m = memFs({ [`${DIR}/agent-A.jsonl`]: jl(user('a0', null, 'p2')), [`${DIR}/agent-B.jsonl`]: jl(user('b0', null, 'p2')) });
    const rm = m.fs.rm;
    m.fs.rm = async (p) => {
      if (p.endsWith('agent-A.jsonl')) throw new Error('EPERM');
      return rm(p);
    };
    const r = await trimSubagents(DIR, ['p2'], m.fs);
    expect(r.removed).toEqual(['B']);
    expect(r.failed).toEqual([{ file: 'agent-A.jsonl', error: 'EPERM' }]);
    expect(await trimSubagents('/nowhere', ['p2'], m.fs)).toEqual({ removed: [], trimmed: [], relinked: 0, failed: [] });
    expect(await trimSubagents(DIR, [], m.fs)).toEqual({ removed: [], trimmed: [], relinked: 0, failed: [] });
  });
});
