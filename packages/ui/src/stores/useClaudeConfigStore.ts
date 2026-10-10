/**
 * Claude-native config store: agents / commands / skills (files under `~/.claude` and `<cwd>/.claude`)
 * and plugins, all read through `claudeClient` (docs/SETTINGS_USAGE_SPEC.md sections 1 and 2).
 * Settings pages (ConfigItemsSidebar, ConfigItemEditor, PluginPage) and the chat autocompletes read from here.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { claudeClient } from '@/lib/claude/client';
import { setCatalog } from '@/lib/claude/bootstrapCache';
import type {
  ConfigItem,
  ConfigItemDetail,
  ConfigItemKind,
  ConfigScope,
  ConfigSnapshot,
} from '@/lib/claude/types';

/** What the editor shows for a kind: an existing item (by path), a new unsaved item in a scope, or nothing. */
export type ConfigSelection = { path: string } | { draft: ConfigScope } | null;

export type ConfigSaveRequest = Parameters<typeof claudeClient.saveConfig>[0];

type ClaudeConfigState = {
  snapshot: ConfigSnapshot | null;
  loading: boolean;
  error: string | null;
  selected: Record<ConfigItemKind, ConfigSelection>;
  /** Detail of the currently opened existing item (one at a time across kinds). */
  detail: ConfigItemDetail | null;
  detailLoading: boolean;
  detailError: string | null;

  /** Loads the snapshot once; concurrent calls share one request. `force` refetches. */
  load: (force?: boolean) => Promise<void>;
  select: (kind: ConfigItemKind, selection: ConfigSelection) => void;
  openDetail: (path: string) => Promise<void>;
  /** Writes the item, reloads the snapshot and selects the saved item. */
  save: (request: ConfigSaveRequest) => Promise<ConfigItem>;
  remove: (path: string) => Promise<void>;
  /** Optimistic; rolls back and rethrows when the host rejects. */
  setPluginEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** `claude:config.reload`: marks live sessions stale and refreshes the catalog, then reloads the snapshot. */
  reloadClaude: () => Promise<void>;
};

const errorMessage = (error: unknown, fallback: string): string => (error instanceof Error ? error.message : fallback);

let inFlight: Promise<void> | null = null;
let inFlightForced = false;
let latestLoad = 0;

export const useClaudeConfigStore = create<ClaudeConfigState>()(
  devtools((set, get) => ({
    snapshot: null,
    loading: false,
    error: null,
    selected: { agent: null, command: null, skill: null },
    detail: null,
    detailLoading: false,
    detailError: null,

    load: (force = false) => {
      // A forced load (after a write) must not piggyback on an unforced one that started before the write.
      if (inFlight && (inFlightForced || !force)) return inFlight;
      if (!inFlight && get().snapshot && !force) return Promise.resolve();
      const id = ++latestLoad;
      set({ loading: true, error: null });
      const run: Promise<void> = claudeClient
        .listConfig()
        .then((snapshot) => {
          // Only the newest request may write: an older response can carry pre-write data.
          if (id === latestLoad) set({ snapshot, loading: false });
        })
        .catch((error: unknown) => {
          if (id === latestLoad) set({ loading: false, error: errorMessage(error, 'Failed to load configuration') });
        })
        .finally(() => {
          if (inFlight === run) inFlight = null;
        });
      inFlight = run;
      inFlightForced = force;
      return run;
    },

    select: (kind, selection) => {
      set((state) => ({
        selected: { ...state.selected, [kind]: selection },
        detail: null,
        detailError: null,
      }));
      if (selection && 'path' in selection) void get().openDetail(selection.path);
    },

    openDetail: async (path) => {
      set({ detailLoading: true, detailError: null });
      try {
        const detail = await claudeClient.readConfig(path);
        // Ignore a stale response when another item was opened meanwhile.
        if (Object.values(get().selected).some((sel) => sel && 'path' in sel && sel.path === path)) {
          set({ detail, detailLoading: false });
        } else {
          set({ detailLoading: false });
        }
      } catch (error) {
        set({ detailLoading: false, detailError: errorMessage(error, 'Failed to read item') });
      }
    },

    save: async (request) => {
      const saved = await claudeClient.saveConfig(request);
      await get().load(true);
      get().select(saved.kind, { path: saved.path });
      return saved;
    },

    remove: async (path) => {
      await claudeClient.deleteConfig(path);
      set((state) => {
        const selected = { ...state.selected };
        for (const kind of Object.keys(selected) as ConfigItemKind[]) {
          const sel = selected[kind];
          if (sel && 'path' in sel && sel.path === path) selected[kind] = null;
        }
        return { selected, detail: state.detail?.path === path ? null : state.detail };
      });
      await get().load(true);
    },

    setPluginEnabled: async (id, enabled) => {
      const previousEnabled = get().snapshot?.plugins.find((plugin) => plugin.id === id)?.enabled;
      if (previousEnabled === undefined) return;
      const patch = (value: boolean) =>
        set((state) =>
          state.snapshot
            ? { snapshot: { ...state.snapshot, plugins: state.snapshot.plugins.map((p) => (p.id === id ? { ...p, enabled: value } : p)) } }
            : state,
        );
      patch(enabled);
      try {
        await claudeClient.setPluginEnabled(id, enabled);
      } catch (error) {
        patch(previousEnabled);
        throw error;
      }
      // Plugin-provided agents / commands / skills appear or disappear with the enabled state.
      await get().load(true);
    },

    reloadClaude: async () => {
      const catalog = await claudeClient.reloadConfig();
      // The host also pushes `catalog.updated`; applying the response now keeps pickers current without waiting.
      setCatalog(catalog);
      await get().load(true);
    },
  })),
);

const itemsByKind = new WeakMap<ConfigSnapshot, Record<ConfigItemKind, ConfigItem[]>>();
const EMPTY_ITEMS: ConfigItem[] = [];

/** Stable selector: `useClaudeConfigStore(selectItems('skill'))` does not re-render while the snapshot is unchanged. */
export const selectItems =
  (kind: ConfigItemKind) =>
  (state: Pick<ClaudeConfigState, 'snapshot'>): ConfigItem[] => {
    const snapshot = state.snapshot;
    if (!snapshot) return EMPTY_ITEMS;
    let grouped = itemsByKind.get(snapshot);
    if (!grouped) {
      grouped = { agent: [], command: [], skill: [] };
      for (const item of snapshot.items) grouped[item.kind].push(item);
      itemsByKind.set(snapshot, grouped);
    }
    return grouped[kind];
  };

export type SkillSuggestion = { name: string; description?: string; scope: 'project' | 'user' };

const suggestionsByItems = new WeakMap<ConfigItem[], SkillSuggestion[]>();

export const selectSkillSuggestions = (state: Pick<ClaudeConfigState, 'snapshot'>): SkillSuggestion[] => {
  const items = selectItems('skill')(state);
  let suggestions = suggestionsByItems.get(items);
  if (!suggestions) {
    // Plugin skills are user-wide as far as the picker is concerned; overridden user skills are hidden.
    suggestions = items
      .filter((item) => !item.shadowed)
      .map((item) => ({ name: item.name, description: item.description, scope: item.source === 'project' ? 'project' : 'user' }));
    suggestionsByItems.set(items, suggestions);
  }
  return suggestions;
};

/** Skills for the chat autocompletes (`/skill`, `/` command list). Call `load()` on mount to populate. */
export const useSkillSuggestions = (): SkillSuggestion[] => useClaudeConfigStore(selectSkillSuggestions);
