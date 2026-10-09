#!/usr/bin/env bun
/**
 * W0 spike: exercises the SDK session helpers against sessions recorded by record-fixture.ts
 * (listSessions, getSessionInfo, getSessionMessages, renameSession, forkSession, deleteSession,
 * listSubagents, getSubagentMessages). Output: src/claude/__fixtures__/session-helpers-probe.json
 *
 * Mutates only sandbox sessions: renames the `text` fixture's session and forks/deletes a copy of `multi-turn`.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  deleteSession,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  getSubagentMessages,
  listSessions,
  listSubagents,
  renameSession,
} from '@anthropic-ai/claude-agent-sdk';
import { FIXTURES_DIR, SANDBOX_DIR, sessionIdFromFixture } from './_common';

const dir = SANDBOX_DIR;
const out: Record<string, unknown> = {};
const attempt = async <T>(fn: () => Promise<T>): Promise<T | { error: string }> => {
  try {
    return await fn();
  } catch (e) {
    return { error: (e as Error).message };
  }
};
const projectDir = join(homedir(), '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
const jsonl = (id: string) => join(projectDir, `${id}.jsonl`);

// 1. listSessions
const all = await listSessions({ dir });
const nonProgrammatic = await listSessions({ dir, includeProgrammatic: false });
out.listSessions = {
  countDefault: all.length,
  countIncludeProgrammaticFalse: nonProgrammatic.length,
  limitOffset: (await listSessions({ dir, limit: 2, offset: 1 })).map((s) => s.sessionId),
  sampleEntry: all[0],
  sortedByLastModifiedDesc: all.every((s, i) => i === 0 || all[i - 1]!.lastModified >= s.lastModified),
  entries: all.map((s) => ({ sessionId: s.sessionId, summary: s.summary, firstPrompt: s.firstPrompt, customTitle: s.customTitle, createdAt: s.createdAt, cwd: s.cwd })),
};

// 2. getSessionInfo
const multiTurnId = sessionIdFromFixture('multi-turn');
out.getSessionInfo = {
  existing: await getSessionInfo(multiTurnId, { dir }),
  existingNoDir: (await getSessionInfo(multiTurnId)) !== undefined,
  missing: (await getSessionInfo('00000000-0000-4000-8000-000000000000', { dir })) ?? null,
};

// 3. getSessionMessages variants
const compactId = sessionIdFromFixture('compact');
const plain = await getSessionMessages(compactId, { dir });
const withSystem = await getSessionMessages(compactId, { dir, includeSystemMessages: true });
out.getSessionMessages = {
  compact: {
    plainTypes: plain.map((m) => m.type),
    withSystemTypes: withSystem.map((m) => m.type),
    systemMessages: withSystem.filter((m) => m.type === 'system'),
  },
  paging: (await getSessionMessages(multiTurnId, { dir, limit: 2, offset: 1 })).map((m) => ({ type: m.type, uuid: m.uuid })),
  missingSession: await attempt(() => getSessionMessages('00000000-0000-4000-8000-000000000000', { dir })),
  messageKeys: Object.keys(plain[0] ?? {}),
};

// 4. renameSession
const textId = sessionIdFromFixture('text');
await renameSession(textId, 'Renamed by W0 probe', { dir });
const renamed = await getSessionInfo(textId, { dir });
out.renameSession = { info: renamed, inList: (await listSessions({ dir })).find((s) => s.sessionId === textId) };

// 5. forkSession + deleteSession
const history = await getSessionMessages(multiTurnId, { dir });
const firstAssistant = history.find((m) => m.type === 'assistant')!;
const fork = await forkSession(multiTurnId, { dir, upToMessageId: firstAssistant.uuid, title: 'W0 probe fork' });
const forkMessages = await getSessionMessages(fork.sessionId, { dir });
const forkInfo = await getSessionInfo(fork.sessionId, { dir });
const existsBeforeDelete = existsSync(jsonl(fork.sessionId));
await deleteSession(fork.sessionId, { dir });
out.forkSession = {
  upToMessageId: firstAssistant.uuid,
  result: fork,
  sourceMessageCount: history.length,
  forkMessageCount: forkMessages.length,
  forkMessageTypes: forkMessages.map((m) => m.type),
  forkUuidsRemapped: forkMessages.every((m) => !history.some((h) => h.uuid === m.uuid)),
  forkInfo,
};
out.deleteSession = {
  jsonlExistedBefore: existsBeforeDelete,
  jsonlExistsAfter: existsSync(jsonl(fork.sessionId)),
  infoAfter: (await getSessionInfo(fork.sessionId, { dir })) ?? null,
  deleteMissing: await attempt(() => deleteSession('00000000-0000-4000-8000-000000000000', { dir })),
};

// 6. subagents
const taskSyncId = sessionIdFromFixture('task-sync');
const taskId = sessionIdFromFixture('task');
const subs = await listSubagents(taskSyncId, { dir });
const subsBg = await listSubagents(taskId, { dir });
out.subagents = {
  taskSync: { ids: subs, messages: subs[0] ? await getSubagentMessages(taskSyncId, subs[0], { dir }) : [] },
  taskBackground: { ids: subsBg, messageCount: subsBg[0] ? (await getSubagentMessages(taskId, subsBg[0], { dir })).length : 0 },
};

writeFileSync(join(FIXTURES_DIR, 'session-helpers-probe.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote session-helpers-probe.json');
console.log(JSON.stringify({
  list: (out.listSessions as { countDefault: number; countIncludeProgrammaticFalse: number }),
  fork: (out.forkSession as { forkMessageCount: number; sourceMessageCount: number }),
  del: out.deleteSession,
  subs: { sync: (out.subagents as any).taskSync.ids, bg: (out.subagents as any).taskBackground.ids },
}, null, 1));
process.exit(0);
