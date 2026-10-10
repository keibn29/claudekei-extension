/**
 * Friendly model and effort names for the composer chip. The catalog's `default` entry hides the real model
 * ("Default (recommended)"), so the label is derived from the concrete id the host reports
 * (`Session.resolvedModel`, e.g. `claude-opus-5-5` -> `Opus 5.5`).
 */

import { EFFORT_LEVELS, type EffortLevel, type ModelInfo } from './types';

const FAMILIES = ['opus', 'sonnet', 'haiku'] as const;

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

/** `(recommended)` suffixes and the 1M marker are display noise in the narrow footer chip. */
export const stripRecommended = (name: string): string => name.replace(/\s*\(recommended\)\s*$/i, '').trim();

/**
 * `claude-opus-5-5` -> `Opus 5.5`, `claude-sonnet-4-5-20250929` -> `Sonnet 4.5`, `claude-3-5-haiku-20241022` ->
 * `Haiku 3.5`, `opus[1m]` -> `Opus 1M`, `opus` -> `Opus`. Unknown ids come back unchanged.
 */
export const prettifyModelId = (id: string): string => {
  const raw = id.trim();
  if (!raw) return raw;
  const million = /\[1m\]/i.test(raw);
  const bare = raw.replace(/\[1m\]/i, '').toLowerCase();
  const family = FAMILIES.find((candidate) => bare.includes(candidate));
  if (!family) return raw;

  // Version digits sit before (`claude-3-5-haiku`) or after (`claude-opus-5-5`) the family; a trailing 8-digit
  // snapshot date is not part of the version.
  const withoutDate = bare.replace(/-\d{8}\b/g, '');
  const after = withoutDate.slice(withoutDate.indexOf(family) + family.length).match(/^[-\s]*(\d+)(?:[-.](\d+))?/);
  const before = withoutDate.slice(0, withoutDate.indexOf(family)).match(/(\d+)(?:[-.](\d+))?[-\s]*$/);
  const match = after ?? before;
  const version = match ? (match[2] !== undefined ? `${match[1]}.${match[2]}` : match[1]) : '';
  return [capitalize(family), version, million ? '1M' : ''].filter(Boolean).join(' ');
};

/** Pulls `Opus 4.5` style text out of a catalog description such as "Use the default model (currently Sonnet 4.5)". */
const nameFromDescription = (description: string | undefined): string | undefined => {
  if (!description) return undefined;
  const match = description.match(/\b(opus|sonnet|haiku)[\s-]*(\d+(?:[.-]\d+)?)?/i);
  if (!match) return undefined;
  const version = match[2]?.replace('-', '.');
  return [capitalize(match[1].toLowerCase()), version].filter(Boolean).join(' ');
};

const hasVersion = (label: string): boolean => /\d/.test(label);

/**
 * Label for the model chip.
 * - `resolved` (running model reported by the host) wins when the selection is `default`/unset or names the same family;
 * - otherwise the selected catalog entry: its `resolvedModel`, then a version found in its description, then its
 *   display name without `(recommended)`.
 */
export const resolveModelLabel = (params: {
  selected?: string;
  resolved?: string;
  models: readonly Pick<ModelInfo, 'value' | 'displayName' | 'description' | 'resolvedModel'>[];
}): string => {
  const { selected, resolved, models } = params;
  const entry = selected ? models.find((model) => model.value === selected) : undefined;
  const isDefault = !selected || selected === 'default' || entry?.value === 'default';
  const million = selected ? /\[1m\]/i.test(selected) : false;
  const withMillion = (label: string) => (million && !/1M$/.test(label) ? `${label} 1M` : label);

  if (resolved) {
    const resolvedLabel = prettifyModelId(resolved);
    const sameFamily = selected ? FAMILIES.some((family) => selected.toLowerCase().includes(family) && resolved.toLowerCase().includes(family)) : false;
    if (isDefault || sameFamily || !entry) return isDefault ? resolvedLabel : withMillion(resolvedLabel);
  }
  if (entry?.resolvedModel) {
    const label = prettifyModelId(entry.resolvedModel);
    if (label !== entry.resolvedModel) return withMillion(label);
  }
  if (entry) {
    const described = isDefault ? nameFromDescription(entry.description) : undefined;
    if (described && hasVersion(described)) return described;
    const label = stripRecommended(entry.displayName || entry.value);
    return label || prettifyModelId(entry.value);
  }
  return selected ? prettifyModelId(selected) : '';
};

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

export const effortLabel = (effort: EffortLevel): string => EFFORT_LABELS[effort];

export const EFFORT_DESCRIPTIONS: Record<EffortLevel, string> = {
  low: 'Fastest, least reasoning',
  medium: 'Balanced speed and depth',
  high: 'Deeper reasoning',
  xhigh: 'Extra deep reasoning',
  max: 'Maximum reasoning',
};

/** Effort levels offered for a model: its `supportedEffortLevels` when the catalog lists them, else all levels. */
export const supportedEffortLevels = (model: Pick<ModelInfo, 'supportsEffort' | 'supportedEffortLevels'> | undefined): readonly EffortLevel[] => {
  if (model?.supportsEffort === false) return [];
  if (model?.supportedEffortLevels && model.supportedEffortLevels.length > 0) {
    return EFFORT_LEVELS.filter((level) => model.supportedEffortLevels!.includes(level));
  }
  return EFFORT_LEVELS;
};

/** Compact chip text: `Opus 5.5 · High` (effort omitted = model default). */
export const formatModelChip = (modelLabel: string, effort: EffortLevel | null | undefined): string =>
  effort ? `${modelLabel} · ${effortLabel(effort)}` : modelLabel;

/** Maps an alias or full id from `claudekei.jsonc` (`opus`, `claude-opus-5-5`) to the catalog `ModelInfo.value`. */
export const matchCatalogModel = <T extends Pick<ModelInfo, 'value' | 'resolvedModel'>>(
  models: readonly T[],
  wanted: string | undefined,
): T | undefined => {
  if (!wanted) return undefined;
  return models.find((model) => model.value === wanted)
    ?? models.find((model) => model.resolvedModel === wanted)
    ?? models.find((model) => model.value !== 'default' && wanted.toLowerCase().includes(model.value.replace(/\[1m\]/i, '').toLowerCase()));
};

/**
 * Title of an assistant message header (`Opus 5.5`) from `AssistantMessage.modelID`. The API reports the concrete id
 * (`claude-opus-5-5`), which is not a catalog value, so it is prettified directly; catalog aliases resolve through the
 * catalog entry.
 */
export const labelForMessageModel = (
  modelID: string,
  models: readonly Pick<ModelInfo, 'value' | 'displayName' | 'description' | 'resolvedModel'>[],
): string => {
  const entry = models.find((model) => model.value === modelID);
  return resolveModelLabel({ selected: modelID, resolved: entry ? undefined : modelID, models });
};

/**
 * Model label and effort of a subagent child session, each omitted when unknown. The concrete model the subagent ran
 * with (`resolvedModel`, from its transcript) wins over the selection; an effort the model does not support is hidden.
 */
export const subagentModelInfo = (
  session: { model?: string; resolvedModel?: string; effort?: EffortLevel } | undefined,
  models: readonly Pick<ModelInfo, 'value' | 'displayName' | 'description' | 'resolvedModel' | 'supportsEffort' | 'supportedEffortLevels'>[],
): { model?: string; effort?: EffortLevel } => {
  const id = session?.resolvedModel ?? session?.model;
  if (!id) return {};
  const model = labelForMessageModel(id, models) || undefined;
  const effort = session?.effort && supportedEffortLevels(matchCatalogModel(models, id)).includes(session.effort) ? session.effort : undefined;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
};

/** Next effort when cycling: model default -> each supported level -> back to model default. */
export const nextEffort = (current: EffortLevel | null, choices: readonly EffortLevel[]): EffortLevel | null => {
  if (choices.length === 0) return null;
  if (current === null) return choices[0];
  const index = choices.indexOf(current);
  return index < 0 || index === choices.length - 1 ? null : choices[index + 1];
};
