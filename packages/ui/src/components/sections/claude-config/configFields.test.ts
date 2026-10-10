import { describe, expect, test } from 'bun:test';
import type { ConfigItem } from '@/lib/claude/types';
import {
  INHERIT_MODEL,
  buildModelOptions,
  emptyFormState,
  fieldSpecsFor,
  formatRelativeTime,
  formStateFromDetail,
  groupItems,
  isFormDirty,
  locationLabel,
  matchesQuery,
  nextFreeName,
  normalizeNameInput,
  validateDraft,
  visibleOtherKeys,
} from './configFields';

const item = (over: Partial<ConfigItem> & Pick<ConfigItem, 'name' | 'source'>): ConfigItem => ({
  kind: 'agent',
  description: '',
  path: `/p/${over.source}/${over.name}.md`,
  ...over,
});

describe('fieldSpecsFor', () => {
  test('follows the host field table order per kind', () => {
    expect(fieldSpecsFor('agent').map((spec) => spec.field)).toEqual(['description', 'model', 'effort', 'color', 'tools']);
    expect(fieldSpecsFor('command').map((spec) => spec.field)).toEqual(['description', 'argument-hint', 'allowed-tools', 'model']);
    expect(fieldSpecsFor('skill').map((spec) => spec.field)).toEqual(['description', 'allowed-tools']);
  });

  test('only description is required', () => {
    for (const kind of ['agent', 'command', 'skill'] as const) {
      expect(fieldSpecsFor(kind).filter((spec) => spec.required).map((spec) => spec.field)).toEqual(['description']);
    }
  });
});

describe('buildModelOptions', () => {
  const models = [
    { value: 'default', displayName: 'Default' },
    { value: 'opus', displayName: 'Opus' },
  ];

  test('inherit first, then catalog models', () => {
    expect(buildModelOptions(models, 'opus', 'Inherit').map((option) => option.value)).toEqual([INHERIT_MODEL, 'default', 'opus']);
  });

  test('keeps an unknown current value so saving does not drop it', () => {
    const options = buildModelOptions(models, 'claude-opus-4-1-20250805', 'Inherit');
    expect(options[options.length - 1]).toEqual({ value: 'claude-opus-4-1-20250805', label: 'claude-opus-4-1-20250805' });
  });

  test('does not duplicate a current value that is already offered and can omit inherit', () => {
    expect(buildModelOptions(models, 'inherit', 'Inherit').filter((option) => option.value === 'inherit')).toHaveLength(1);
    expect(buildModelOptions(models, '', null).map((option) => option.value)).toEqual(['default', 'opus']);
  });
});

describe('validateDraft', () => {
  test('requires a valid name on create and a description', () => {
    expect(validateDraft('agent', '', {}, { checkName: true })).toEqual({ name: 'required', description: 'required' });
    expect(validateDraft('agent', 'Bad Name', { description: 'x' }, { checkName: true })).toEqual({ name: 'invalidName' });
    expect(validateDraft('skill', 'ok-name', { description: 'x' }, { checkName: true })).toEqual({});
  });

  test('does not check the name when editing', () => {
    expect(validateDraft('agent', 'Legacy_Name', { description: 'x' }, { checkName: false })).toEqual({});
  });

  test('whitespace-only description is missing', () => {
    expect(validateDraft('command', 'a', { description: '   ' }, { checkName: true })).toEqual({ description: 'required' });
  });
});

describe('names', () => {
  test('nextFreeName appends a counter', () => {
    expect(nextFreeName('new-agent', [])).toBe('new-agent');
    expect(nextFreeName('new-agent', ['new-agent'])).toBe('new-agent-2');
    expect(nextFreeName('new-agent', ['new-agent', 'new-agent-2'])).toBe('new-agent-3');
  });

  test('normalizeNameInput lowercases and dashes separators', () => {
    expect(normalizeNameInput('My Cool_Agent')).toBe('my-cool-agent');
  });
});

describe('groupItems', () => {
  const items: ConfigItem[] = [
    item({ name: 'zeta', source: 'user' }),
    item({ name: 'alpha', source: 'user', description: 'Finds bugs' }),
    item({ name: 'proj', source: 'project' }),
    item({ name: 'claudekei:oracle', source: 'plugin', plugin: 'claudekei@claudekei' }),
    item({ name: 'claudekei:planner', source: 'plugin', plugin: 'claudekei@claudekei' }),
    item({ name: 'sp:brainstorm', source: 'plugin', plugin: 'superpowers@market' }),
  ];

  test('splits into project, user and plugin groups, sorted by name', () => {
    const groups = groupItems(items);
    expect(groups.project.map((entry) => entry.name)).toEqual(['proj']);
    expect(groups.user.map((entry) => entry.name)).toEqual(['alpha', 'zeta']);
    expect(groups.plugins.map((group) => [group.plugin, group.items.length])).toEqual([['claudekei', 2], ['superpowers', 1]]);
  });

  test('filters by name, description and command group', () => {
    expect(groupItems(items, 'bugs').user.map((entry) => entry.name)).toEqual(['alpha']);
    expect(groupItems(items, 'ORACLE').plugins).toHaveLength(1);
    expect(matchesQuery(item({ kind: 'command', name: 'deploy', source: 'user', group: 'ops' }), 'ops')).toBe(true);
    expect(groupItems(items, 'nothing-matches')).toEqual({ project: [], user: [], plugins: [] });
  });
});

describe('form state', () => {
  const detail = { kind: 'agent' as const, fields: { description: 'D', model: 'sonnet' }, body: 'Body' };

  test('fills every field of the kind, missing ones empty', () => {
    expect(formStateFromDetail(detail).fields).toEqual({ description: 'D', model: 'sonnet', effort: '', color: '', tools: '' });
    expect(emptyFormState('skill')).toEqual({ fields: { description: '', 'allowed-tools': '' }, body: '' });
  });

  test('dirty detection ignores missing vs empty', () => {
    const saved = formStateFromDetail(detail);
    expect(isFormDirty(saved, saved)).toBe(false);
    expect(isFormDirty({ ...saved, fields: { ...saved.fields, effort: undefined } }, saved)).toBe(false);
    expect(isFormDirty({ ...saved, body: 'Body!' }, saved)).toBe(true);
    expect(isFormDirty({ ...saved, fields: { ...saved.fields, color: 'red' } }, saved)).toBe(true);
  });
});

describe('display helpers', () => {
  test('locationLabel', () => {
    expect(locationLabel('user', 'skill')).toBe('~/.claude/skills');
    expect(locationLabel('project', 'command')).toBe('.claude/commands');
  });

  test('visibleOtherKeys hides the managed name key', () => {
    expect(visibleOtherKeys(['name', 'skills', 'hooks'])).toEqual(['skills', 'hooks']);
  });

  test('formatRelativeTime', () => {
    const now = Date.UTC(2026, 9, 10, 12);
    expect(formatRelativeTime(now - 3 * 86_400_000, now, 'en')).toBe('3 days ago');
    expect(formatRelativeTime(now - 2 * 3_600_000, now, 'en')).toBe('2 hours ago');
    expect(formatRelativeTime(now - 10_000, now, 'en')).toBe('10 seconds ago');
  });
});
