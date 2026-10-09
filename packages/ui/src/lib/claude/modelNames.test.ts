import { describe, expect, test } from 'bun:test';
import {
  effortLabel,
  formatModelChip,
  matchCatalogModel,
  prettifyModelId,
  resolveModelLabel,
  stripRecommended,
  supportedEffortLevels,
} from './modelNames';

const models = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 4.5)' },
  { value: 'opus', displayName: 'Opus', description: 'Most capable', resolvedModel: 'claude-opus-5-5' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Balanced', resolvedModel: 'claude-sonnet-4-5-20250929' },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest' },
  { value: 'opus[1m]', displayName: 'Opus (1M context)', description: 'Long context', resolvedModel: 'claude-opus-5-5' },
];

describe('prettifyModelId', () => {
  test('formats concrete ids', () => {
    expect(prettifyModelId('claude-opus-5-5')).toBe('Opus 5.5');
    expect(prettifyModelId('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(prettifyModelId('claude-3-5-haiku-20241022')).toBe('Haiku 3.5');
    expect(prettifyModelId('claude-opus-4')).toBe('Opus 4');
  });
  test('aliases and the 1M marker', () => {
    expect(prettifyModelId('opus')).toBe('Opus');
    expect(prettifyModelId('opus[1m]')).toBe('Opus 1M');
    expect(prettifyModelId('claude-opus-5-5[1m]')).toBe('Opus 5.5 1M');
  });
  test('unknown ids come back unchanged', () => {
    expect(prettifyModelId('gpt-x')).toBe('gpt-x');
    expect(prettifyModelId('')).toBe('');
  });
});

describe('resolveModelLabel', () => {
  test('default selection shows the model the host actually runs', () => {
    expect(resolveModelLabel({ selected: 'default', resolved: 'claude-opus-5-5', models })).toBe('Opus 5.5');
    expect(resolveModelLabel({ selected: undefined, resolved: 'claude-sonnet-4-5-20250929', models })).toBe('Sonnet 4.5');
  });

  test('a draft with the default entry names the underlying model from the catalog', () => {
    expect(resolveModelLabel({ selected: 'default', models })).toBe('Opus 4.5');
    expect(resolveModelLabel({ selected: 'default', models: [{ value: 'default', displayName: 'Default (recommended)', description: 'x', resolvedModel: 'claude-opus-5-5' }] })).toBe('Opus 5.5');
  });

  test('explicit selections use the catalog entry, then fall back to the display name', () => {
    expect(resolveModelLabel({ selected: 'sonnet', models })).toBe('Sonnet 4.5');
    expect(resolveModelLabel({ selected: 'haiku', models })).toBe('Haiku');
    expect(resolveModelLabel({ selected: 'opus[1m]', models })).toBe('Opus 5.5 1M');
  });

  test('a pending model change is not masked by the previously running model', () => {
    // selected sonnet, still running opus until the respawn: show the selection
    expect(resolveModelLabel({ selected: 'sonnet', resolved: 'claude-opus-5-5', models })).toBe('Sonnet 4.5');
    // same family: the concrete running id is the most precise name
    expect(resolveModelLabel({ selected: 'opus', resolved: 'claude-opus-5-5', models })).toBe('Opus 5.5');
  });

  test('"(recommended)" is stripped and unknown values are prettified', () => {
    expect(resolveModelLabel({ selected: 'default', models: [{ value: 'default', displayName: 'Default (recommended)', description: '' }] })).toBe('Default');
    expect(stripRecommended('Opus (recommended)')).toBe('Opus');
    expect(resolveModelLabel({ selected: 'claude-sonnet-4-5', models: [] })).toBe('Sonnet 4.5');
    expect(resolveModelLabel({ models })).toBe('');
  });
});

describe('effort helpers', () => {
  test('labels and chip text', () => {
    expect(effortLabel('xhigh')).toBe('XHigh');
    expect(formatModelChip('Opus 5.5', 'high')).toBe('Opus 5.5 · High');
    expect(formatModelChip('Opus 5.5', null)).toBe('Opus 5.5');
    expect(formatModelChip('Opus 5.5', undefined)).toBe('Opus 5.5');
  });

  test('only supported levels are offered; unlisted means all; unsupported means none', () => {
    expect(supportedEffortLevels({ supportedEffortLevels: ['low', 'high', 'max'] })).toEqual(['low', 'high', 'max']);
    expect(supportedEffortLevels({})).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(supportedEffortLevels(undefined)).toHaveLength(5);
    expect(supportedEffortLevels({ supportsEffort: false })).toEqual([]);
  });

  test('catalog model matching by value, resolved id and alias inside a full id', () => {
    expect(matchCatalogModel(models, 'opus')?.value).toBe('opus');
    expect(matchCatalogModel(models, 'claude-sonnet-4-5-20250929')?.value).toBe('sonnet');
    expect(matchCatalogModel(models, 'claude-haiku-4-5')?.value).toBe('haiku');
    expect(matchCatalogModel(models, undefined)).toBeUndefined();
  });
});

describe('message header model label', () => {
  test('concrete API ids are prettified; catalog aliases use the catalog entry', async () => {
    const { labelForMessageModel } = await import('./modelNames');
    expect(labelForMessageModel('claude-opus-5-5', models)).toBe('Opus 5.5');
    expect(labelForMessageModel('claude-sonnet-4-5-20250929', models)).toBe('Sonnet 4.5');
    expect(labelForMessageModel('sonnet', models)).toBe('Sonnet 4.5');
    expect(labelForMessageModel('haiku', models)).toBe('Haiku');
    expect(labelForMessageModel('default', models)).toBe('Opus 4.5');
    expect(labelForMessageModel('claude-opus-5-5[1m]', models)).toBe('Opus 5.5 1M');
  });
});

describe('nextEffort (cycling)', () => {
  test('model default -> levels -> model default', async () => {
    const { nextEffort } = await import('./modelNames');
    const choices = ['low', 'high', 'max'] as const;
    expect(nextEffort(null, choices)).toBe('low');
    expect(nextEffort('low', choices)).toBe('high');
    expect(nextEffort('max', choices)).toBeNull();
    expect(nextEffort('xhigh', choices)).toBeNull();
    expect(nextEffort(null, [])).toBeNull();
  });
});
