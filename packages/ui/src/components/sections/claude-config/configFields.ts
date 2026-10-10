/**
 * Field table and pure helpers for the agents / commands / skills settings pages
 * (docs/SETTINGS_USAGE_SPEC.md 1.4-1.6). Kept free of React so it can be unit tested.
 */

import {
  AGENT_COLORS,
  CONFIG_FIELDS,
  CONFIG_NAME_PATTERN,
  EFFORT_LEVELS,
  type ConfigField,
  type ConfigItem,
  type ConfigItemDetail,
  type ConfigItemKind,
  type ConfigScope,
  type ModelInfo,
} from '@/lib/claude/types';
import type { I18nKey } from '@/lib/i18n';

export type FieldInput = 'textarea' | 'text' | 'model' | 'effort' | 'color';

export type FieldSpec = {
  field: ConfigField;
  input: FieldInput;
  /** Required for the item to be saved. */
  required: boolean;
  label: I18nKey;
  hint: I18nKey;
  placeholder?: I18nKey;
};

/** Frontmatter value meaning "use the caller's model". */
export const INHERIT_MODEL = 'inherit';

const FIELD_SPECS: Record<ConfigField, FieldSpec> = {
  description: {
    field: 'description',
    input: 'textarea',
    required: true,
    label: 'claudeConfig.field.description.label',
    hint: 'claudeConfig.field.description.hint',
    placeholder: 'claudeConfig.field.description.placeholder',
  },
  model: {
    field: 'model',
    input: 'model',
    required: false,
    label: 'claudeConfig.field.model.label',
    hint: 'claudeConfig.field.model.hint',
  },
  effort: {
    field: 'effort',
    input: 'effort',
    required: false,
    label: 'claudeConfig.field.effort.label',
    hint: 'claudeConfig.field.effort.hint',
  },
  color: {
    field: 'color',
    input: 'color',
    required: false,
    label: 'claudeConfig.field.color.label',
    hint: 'claudeConfig.field.color.hint',
  },
  tools: {
    field: 'tools',
    input: 'text',
    required: false,
    label: 'claudeConfig.field.tools.label',
    hint: 'claudeConfig.field.tools.hint',
    placeholder: 'claudeConfig.field.tools.placeholder',
  },
  'argument-hint': {
    field: 'argument-hint',
    input: 'text',
    required: false,
    label: 'claudeConfig.field.argumentHint.label',
    hint: 'claudeConfig.field.argumentHint.hint',
    placeholder: 'claudeConfig.field.argumentHint.placeholder',
  },
  'allowed-tools': {
    field: 'allowed-tools',
    input: 'text',
    required: false,
    label: 'claudeConfig.field.allowedTools.label',
    hint: 'claudeConfig.field.allowedTools.hint',
    placeholder: 'claudeConfig.field.allowedTools.placeholder',
  },
};

/** Form fields for a kind, in display order (`CONFIG_FIELDS` is the host contract). */
export const fieldSpecsFor = (kind: ConfigItemKind): FieldSpec[] =>
  CONFIG_FIELDS[kind].map((field) => FIELD_SPECS[field]);

/** Where the item lives under its root, for display. */
export const KIND_DIR: Record<ConfigItemKind, string> = {
  agent: 'agents',
  command: 'commands',
  skill: 'skills',
};

/** Per-kind UI strings (keys live in en.configPages.ts). */
export const KIND_KEYS: Record<ConfigItemKind, { singular: I18nKey; empty: I18nKey; selectPrompt: I18nKey; body: I18nKey; bodyPlaceholder: I18nKey }> = {
  agent: {
    singular: 'claudeConfig.agent.singular',
    empty: 'claudeConfig.agent.empty',
    selectPrompt: 'claudeConfig.agent.selectPrompt',
    body: 'claudeConfig.body.agent',
    bodyPlaceholder: 'claudeConfig.body.placeholder.agent',
  },
  command: {
    singular: 'claudeConfig.command.singular',
    empty: 'claudeConfig.command.empty',
    selectPrompt: 'claudeConfig.command.selectPrompt',
    body: 'claudeConfig.body.command',
    bodyPlaceholder: 'claudeConfig.body.placeholder.command',
  },
  skill: {
    singular: 'claudeConfig.skill.singular',
    empty: 'claudeConfig.skill.empty',
    selectPrompt: 'claudeConfig.skill.selectPrompt',
    body: 'claudeConfig.body.skill',
    bodyPlaceholder: 'claudeConfig.body.placeholder.skill',
  },
};

/** Select value standing for "field not set" (empty strings are not valid select values). */
export const UNSET_VALUE = '__unset__';

export const EFFORT_OPTIONS: readonly string[] = EFFORT_LEVELS;

export const COLOR_OPTIONS: readonly string[] = AGENT_COLORS;

/** Theme variable behind each Claude Code agent color name (same mapping as `lib/agentColors`). */
export const AGENT_COLOR_VARS: Record<string, string> = {
  red: '--status-error',
  orange: '--status-warning',
  yellow: '--status-warning',
  green: '--status-success',
  cyan: '--status-info',
  blue: '--status-info',
  purple: '--syntax-keyword',
  pink: '--syntax-number',
};

export type ModelOption = { value: string; label: string };

/**
 * Model choices: `inherit`, every catalog model, plus the file's current value when it is none of those
 * (a full model id, an alias from another Claude version) so it is never silently dropped on save.
 */
export const buildModelOptions = (
  models: ReadonlyArray<Pick<ModelInfo, 'value' | 'displayName'>>,
  current: string | undefined,
  /** Label of the leading `inherit` option; `null` omits it (commands have no `inherit`). */
  inheritLabel: string | null,
): ModelOption[] => {
  const options: ModelOption[] = inheritLabel === null ? [] : [{ value: INHERIT_MODEL, label: inheritLabel }];
  const seen = new Set<string>(inheritLabel === null ? [] : [INHERIT_MODEL]);
  for (const model of models) {
    if (seen.has(model.value)) continue;
    seen.add(model.value);
    options.push({ value: model.value, label: model.displayName || model.value });
  }
  const trimmed = current?.trim();
  if (trimmed && !seen.has(trimmed)) {
    options.push({ value: trimmed, label: trimmed });
  }
  return options;
};

export type DraftErrors = Partial<Record<'name' | ConfigField, 'required' | 'invalidName'>>;

/** Client-side mirror of the host validation so the form can disable Save with a hint. */
export const validateDraft = (
  kind: ConfigItemKind,
  name: string,
  fields: Partial<Record<ConfigField, string>>,
  options: { checkName: boolean },
): DraftErrors => {
  const errors: DraftErrors = {};
  if (options.checkName) {
    if (name.trim().length === 0) errors.name = 'required';
    else if (!CONFIG_NAME_PATTERN.test(name)) errors.name = 'invalidName';
  }
  for (const spec of fieldSpecsFor(kind)) {
    if (spec.required && (fields[spec.field] ?? '').trim().length === 0) {
      errors[spec.field] = 'required';
    }
  }
  return errors;
};

/** `new-agent`, `new-agent-2`, ... not colliding with an existing item name in the scope. */
export const nextFreeName = (base: string, taken: Iterable<string>): string => {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
};

/** Normalizes typed names towards CONFIG_NAME_PATTERN (lowercase, spaces and underscores to dashes). */
export const normalizeNameInput = (value: string): string => value.toLowerCase().replace(/[\s_]+/g, '-');

export type ItemGroups = {
  project: ConfigItem[];
  user: ConfigItem[];
  /** Plugin display name (manifest name, e.g. `claudekei`) to its items, in first-seen order. */
  plugins: Array<{ plugin: string; items: ConfigItem[] }>;
};

const pluginDisplayName = (item: ConfigItem): string => {
  const fromId = item.plugin?.split('@')[0];
  if (fromId) return fromId;
  const colon = item.name.indexOf(':');
  return colon > 0 ? item.name.slice(0, colon) : 'plugin';
};

/** Case-insensitive match on name, description and (for commands) group. */
export const matchesQuery = (item: ConfigItem, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [item.name, item.description, item.group ?? ''].some((value) => value.toLowerCase().includes(needle));
};

export const groupItems = (items: readonly ConfigItem[], query = ''): ItemGroups => {
  const groups: ItemGroups = { project: [], user: [], plugins: [] };
  const byPlugin = new Map<string, ConfigItem[]>();
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
  for (const item of sorted) {
    if (!matchesQuery(item, query)) continue;
    if (item.source === 'project') groups.project.push(item);
    else if (item.source === 'user') groups.user.push(item);
    else {
      const key = pluginDisplayName(item);
      const list = byPlugin.get(key) ?? [];
      list.push(item);
      byPlugin.set(key, list);
    }
  }
  for (const [plugin, list] of byPlugin) groups.plugins.push({ plugin, items: list });
  groups.plugins.sort((a, b) => a.plugin.localeCompare(b.plugin));
  return groups;
};

/** Editable state of the form, derived from the item detail. */
export type FormState = {
  fields: Partial<Record<ConfigField, string>>;
  body: string;
};

export const formStateFromDetail = (detail: Pick<ConfigItemDetail, 'kind' | 'fields' | 'body'>): FormState => {
  const fields: Partial<Record<ConfigField, string>> = {};
  for (const field of CONFIG_FIELDS[detail.kind]) fields[field] = detail.fields[field] ?? '';
  return { fields, body: detail.body };
};

export const emptyFormState = (kind: ConfigItemKind): FormState => formStateFromDetail({ kind, fields: {}, body: '' });

export const isFormDirty = (current: FormState, saved: FormState): boolean =>
  current.body !== saved.body || Object.keys({ ...current.fields, ...saved.fields }).some((key) => {
    const field = key as ConfigField;
    return (current.fields[field] ?? '') !== (saved.fields[field] ?? '');
  });

/** Display path under a scope root, e.g. `~/.claude/agents` or `.claude/skills`. */
export const locationLabel = (scope: ConfigScope, kind: ConfigItemKind): string =>
  `${scope === 'user' ? '~/.claude' : '.claude'}/${KIND_DIR[kind]}`;

/** Names that make no sense to show as `otherKeys` hints (managed by the form or the file name). */
export const visibleOtherKeys = (keys: readonly string[]): string[] => keys.filter((key) => key !== 'name');

/** `Intl.RelativeTimeFormat` wrapper: "3 days ago", "in 2 hours". */
export const formatRelativeTime = (timestamp: number, now: number, locale: string): string => {
  const seconds = Math.round((timestamp - now) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(Math.min(0, seconds), 'second');
};

/** Message of a thrown value, for toasts. */
export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
