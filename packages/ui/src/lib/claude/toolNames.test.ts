import { describe, expect, test } from 'bun:test';
import { CLAUDE_TOOL_NAME_MAP, normalizeToolName } from './toolNames';

describe('normalizeToolName', () => {
  test('maps known Claude tools to normalized names', () => {
    expect(normalizeToolName('Bash')).toBe('bash');
    expect(normalizeToolName('Edit')).toBe('edit');
    expect(normalizeToolName('MultiEdit')).toBe('multiedit');
    expect(normalizeToolName('LS')).toBe('list');
    expect(normalizeToolName('TodoWrite')).toBe('todowrite');
    expect(normalizeToolName('AskUserQuestion')).toBe('question');
    expect(normalizeToolName('ExitPlanMode')).toBe('plan_exit');
  });

  test('maps Task and Agent to task', () => {
    expect(normalizeToolName('Task')).toBe('task');
    expect(normalizeToolName('Agent')).toBe('task');
  });

  test('maps SendMessage to sendmessage', () => {
    expect(normalizeToolName('SendMessage')).toBe('sendmessage');
  });

  test('passes unknown and mcp tools through unchanged', () => {
    expect(normalizeToolName('SomethingNew')).toBe('SomethingNew');
    expect(normalizeToolName('NotebookEdit')).toBe('NotebookEdit');
    expect(normalizeToolName('mcp__github__create_issue')).toBe('mcp__github__create_issue');
  });

  test('does not resolve inherited object keys', () => {
    expect(normalizeToolName('toString')).toBe('toString');
    expect(normalizeToolName('constructor')).toBe('constructor');
  });

  test('every table entry is stable under its own mapping', () => {
    for (const [name, normalized] of Object.entries(CLAUDE_TOOL_NAME_MAP)) {
      expect(normalizeToolName(name)).toBe(normalized);
    }
  });
});
