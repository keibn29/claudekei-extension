import { describe, expect, test } from 'bun:test';
import { encodeProjectDir, readSubagentMeta } from './subagentMeta';

const DIR = '/h/.claude/projects/-Users-kei-my-proj/sess/subagents';
const files: Record<string, string> = {
  [`${DIR}/agent-a1.meta.json`]: JSON.stringify({ agentType: 'claudekei:backend-developer', toolUseId: 'toolu_1', model: 'sonnet', effort: 'medium' }),
  [`${DIR}/agent-a2.meta.json`]: JSON.stringify({ toolUseId: 'toolu_2', effort: 'turbo' }),
  [`${DIR}/agent-a3.jsonl`]: '',
};
const options = { cwd: '/Users/kei/my.proj', sessionId: 'sess', home: '/h', listDir: () => Object.keys(files).map((f) => f.split('/').pop()!), readFile: (p: string) => files[p] ?? ((): never => { throw new Error('ENOENT'); })() };

describe('subagent meta files', () => {
  test('project dir encoding replaces every non-alphanumeric character', () => {
    expect(encodeProjectDir('/Users/kei/my.proj_x')).toBe('-Users-kei-my-proj-x');
  });

  test('found by tool_use id (scan) or directly by agent id', () => {
    expect(readSubagentMeta('toolu_1', undefined, options)).toEqual({ agentId: 'a1', model: 'sonnet', effort: 'medium' });
    expect(readSubagentMeta('toolu_1', 'a1', options)).toEqual({ agentId: 'a1', model: 'sonnet', effort: 'medium' });
  });

  test('invalid fields are dropped; unknown tool ids and missing directories yield undefined', () => {
    expect(readSubagentMeta('toolu_2', undefined, options)).toEqual({ agentId: 'a2' });
    expect(readSubagentMeta('toolu_9', undefined, options)).toBeUndefined();
    expect(readSubagentMeta('toolu_1', 'nope', options)).toBeUndefined();
    expect(readSubagentMeta('toolu_1', undefined, { ...options, listDir: () => { throw new Error('ENOENT'); } })).toBeUndefined();
  });
});
