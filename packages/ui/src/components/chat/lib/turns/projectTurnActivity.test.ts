import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@/lib/claude/types';
import { projectTurnActivity } from './projectTurnActivity';
import type { ChatMessageEntry } from './types';

const tool = (id: string, name: string, metadata: Record<string, unknown> = {}): Part => ({
  id, sessionID: 's', messageID: 'a1', type: 'tool', tool: name, callID: `c_${id}`, claude: { name, input: {} },
  state: { status: 'completed', input: {}, output: '', title: '', metadata, time: { start: 1, end: 2 } },
} as unknown as Part);

const message = (parts: Part[]): ChatMessageEntry => ({
  info: { id: 'a1', sessionID: 's', role: 'assistant', parentID: 'u1', time: { created: 1 } } as Message,
  parts,
});

const project = (parts: Part[]) => projectTurnActivity({
  turnId: 't1',
  assistantMessages: [message(parts)],
  showTextJustificationActivity: false,
});

describe('projectTurnActivity', () => {
  test('hidden tool parts produce no activity rows and do not count as tools', () => {
    const result = project([tool('hidden', 'ToolSearch', { hidden: true })]);
    expect(result.activityParts).toHaveLength(0);
    expect(result.hasTools).toBe(false);
  });

  test('visible tools stay; subagent tools are standalone and anchor segments', () => {
    const result = project([tool('hidden', 'ToolSearch', { hidden: true }), tool('read', 'read'), tool('send', 'sendmessage'), tool('grep', 'grep')]);
    expect(result.activityParts.map((activity) => activity.id)).toEqual(['read', 'send', 'grep']);
    expect(result.hasTools).toBe(true);
    // `sendmessage` is standalone like `task`: it splits the activity into segments and is not grouped inside them.
    expect(result.activitySegments.map((segment) => segment.parts.map((activity) => activity.id))).toEqual([['read'], ['grep']]);
  });
});
