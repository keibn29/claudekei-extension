import { describe, expect, test } from 'bun:test';
import { camelCase, isTaskTool, normalizeToolInput, toolTitle } from './toolNormalize';

describe('camelCase', () => {
  test('converts snake/kebab, keeps flags', () => {
    expect(camelCase('file_path')).toBe('filePath');
    expect(camelCase('a-b-c')).toBe('aBC');
    expect(camelCase('-i')).toBe('-i');
    expect(camelCase('already')).toBe('already');
  });
});

describe('normalizeToolInput', () => {
  test('edit', () => {
    expect(normalizeToolInput('Edit', { file_path: '/a', old_string: 'x', new_string: 'y', replace_all: false })).toEqual({
      filePath: '/a',
      oldString: 'x',
      newString: 'y',
      replaceAll: false,
    });
  });

  test('read / write / bash', () => {
    expect(normalizeToolInput('Read', { file_path: '/a', offset: 2, limit: 5 })).toEqual({ filePath: '/a', offset: 2, limit: 5 });
    expect(normalizeToolInput('Write', { file_path: '/a', content: 'c' })).toEqual({ filePath: '/a', content: 'c' });
    expect(normalizeToolInput('Bash', { command: 'ls', run_in_background: true, description: 'd' })).toEqual({
      command: 'ls',
      runInBackground: true,
      description: 'd',
    });
  });

  test('grep renames glob and flags', () => {
    expect(normalizeToolInput('Grep', { pattern: 'p', glob: '*.ts', output_mode: 'content', '-i': true, '-C': 2 })).toEqual({
      pattern: 'p',
      include: '*.ts',
      outputMode: 'content',
      caseInsensitive: true,
      context: 2,
    });
  });

  test('multiedit', () => {
    const out = normalizeToolInput('MultiEdit', { file_path: '/a', edits: [{ old_string: 'a', new_string: 'b' }] });
    expect(out).toEqual({ filePath: '/a', edits: [{ oldString: 'a', newString: 'b' }] });
  });

  test('todowrite adds ids and priority, keeps activeForm', () => {
    const out = normalizeToolInput('TodoWrite', { todos: [{ content: 'a', status: 'pending', activeForm: 'Doing a' }] });
    expect(out.todos).toEqual([{ id: '1', content: 'a', status: 'pending', priority: 'medium', activeForm: 'Doing a' }]);
  });

  test('task keeps subagent_type for both Agent and Task', () => {
    for (const name of ['Agent', 'Task']) {
      expect(isTaskTool(name)).toBe(true);
      expect(normalizeToolInput(name, { description: 'd', prompt: 'p', subagent_type: 'general-purpose', run_in_background: false })).toEqual({
        description: 'd',
        prompt: 'p',
        subagent_type: 'general-purpose',
        runInBackground: false,
      });
    }
  });

  test('question maps multiSelect to multiple', () => {
    const out = normalizeToolInput('AskUserQuestion', { questions: [{ question: 'q', header: 'h', options: [], multiSelect: true }] });
    expect(out.questions).toEqual([{ question: 'q', header: 'h', options: [], multiple: true }]);
  });

  test('skill, exit plan mode, unknown and mcp tools', () => {
    expect(normalizeToolInput('Skill', { skill: 'pdf', args: 'x' })).toEqual({ name: 'pdf', args: 'x' });
    expect(normalizeToolInput('ExitPlanMode', { plan: 'p', planFilePath: '/x' })).toEqual({ plan: 'p', planFilePath: '/x' });
    expect(normalizeToolInput('TaskCreate', { subject: 's', some_key: 1 })).toEqual({ subject: 's', some_key: 1 });
    expect(normalizeToolInput('mcp__srv__do_it', { snake_key: 1 })).toEqual({ snake_key: 1 });
  });

  test('non-object input yields {}', () => {
    expect(normalizeToolInput('Edit', null)).toEqual({});
    expect(normalizeToolInput('Edit', 'x')).toEqual({});
    expect(normalizeToolInput('Edit', [1])).toEqual({});
  });
});

describe('toolTitle', () => {
  test('per tool', () => {
    expect(toolTitle('edit', { filePath: '/w/a.ts' }, '/w')).toBe('a.ts');
    expect(toolTitle('bash', { command: 'ls\nfoo', description: '' }, '/w')).toBe('ls');
    expect(toolTitle('bash', { command: 'ls', description: 'List' }, '/w')).toBe('List');
    expect(toolTitle('task', { description: 'Do it' }, '/w')).toBe('Do it');
    expect(toolTitle('other', {}, '/w')).toBe('');
  });
});
