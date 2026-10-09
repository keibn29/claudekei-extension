import { describe, expect, test } from 'bun:test';
import type { Part } from '@/lib/claude/types';
import { filterVisibleParts } from './partUtils';

const toolPart = (id: string, tool: string, metadata: Record<string, unknown> = {}): Part => ({
  id, sessionID: 's', messageID: 'm', type: 'tool', tool, callID: `c_${id}`, claude: { name: tool, input: {} },
  state: { status: 'completed', input: {}, output: '', title: '', metadata, time: { start: 1, end: 2 } },
} as unknown as Part);

describe('filterVisibleParts', () => {
  test('drops tool parts the host marked hidden (the ToolSearch select:SendMessage row)', () => {
    const parts = [
      { id: 't', sessionID: 's', messageID: 'm', type: 'text', text: 'hello' } as Part,
      toolPart('hidden', 'ToolSearch', { hidden: true }),
      toolPart('visible', 'read'),
      toolPart('search', 'ToolSearch'),
    ];
    expect(filterVisibleParts(parts).map((part) => part.id)).toEqual(['t', 'visible', 'search']);
  });
});
