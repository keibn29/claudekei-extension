/**
 * Claude-native MCP store: server list and status come from the host's runtime probe (`claudeClient.mcpStatus`),
 * edits go through the bundled CLI (`saveMcp` / `removeMcp`) and enable/disable through `toggleMcp`
 * (docs/SETTINGS_USAGE_SPEC.md sections 1.7 and 2).
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { claudeClient } from '@/lib/claude/client';
import type { McpServerInfo, McpServerScope, McpStatusSnapshot, McpTransportConfig } from '@/lib/claude/types';

export type McpHealth = {
  connected: number;
  total: number;
  hasFailed: boolean;
  hasAuthRequired: boolean;
};

/** `'new'` is the draft form for a server that does not exist yet. */
export type McpSelection = string | 'new' | null;

export const computeMcpHealth = (servers: McpServerInfo[] | null | undefined): McpHealth => {
  const list = servers ?? [];
  return {
    connected: list.filter((server) => server.status === 'connected').length,
    total: list.length,
    hasFailed: list.some((server) => server.status === 'failed'),
    hasAuthRequired: list.some((server) => server.status === 'needs-auth'),
  };
};

type McpState = {
  snapshot: McpStatusSnapshot | null;
  loading: boolean;
  error: string | null;
  selected: McpSelection;
  /** Flips to false for the rest of the session once the host reports that toggling is not supported. */
  toggleSupported: boolean;

  select: (selection: McpSelection) => void;
  /** `force` re-probes the servers; otherwise the host may answer from its short cache. */
  refresh: (force?: boolean) => Promise<void>;
  save: (name: string, scope: McpServerScope, config: McpTransportConfig, create: boolean) => Promise<void>;
  remove: (name: string, scope: McpServerScope) => Promise<void>;
  /** Optimistic: the row flips immediately and rolls back if the host rejects. Rethrows so callers can toast. */
  toggle: (name: string, enabled: boolean) => Promise<void>;
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

let latestRequest = 0;
let inflight: Promise<void> | null = null;
let inflightForce = false;
const toggling = new Set<string>();

export const useMcpStore = create<McpState>()(
  devtools((set, get) => {
    const patchServer = (name: string, patch: Partial<McpServerInfo>) =>
      set((state) =>
        state.snapshot
          ? {
              snapshot: {
                ...state.snapshot,
                servers: state.snapshot.servers.map((server) => (server.name === name ? { ...server, ...patch } : server)),
              },
            }
          : state,
      );

    return {
      snapshot: null,
      loading: false,
      error: null,
      selected: null,
      toggleSupported: true,

      select: (selection) => set({ selected: selection }),

      refresh: (force = false) => {
        // A forced probe must not piggyback on a cached one; anything else can share the in-flight request.
        if (inflight && (inflightForce || !force)) return inflight;
        const id = ++latestRequest;
        const run = (async () => {
          set({ loading: true, error: null });
          try {
            const snapshot = await claudeClient.mcpStatus(force);
            if (id === latestRequest) set({ snapshot, loading: false });
          } catch (error) {
            if (id === latestRequest) set({ loading: false, error: errorMessage(error) });
          }
        })();
        inflight = run;
        inflightForce = force;
        void run.finally(() => {
          if (inflight === run) inflight = null;
        });
        return run;
      },

      save: async (name, scope, config, create) => {
        await claudeClient.saveMcp(name, scope, config, create);
        if (create) set({ selected: name });
        await get().refresh(true);
      },

      remove: async (name, scope) => {
        await claudeClient.removeMcp(name, scope);
        if (get().selected === name) set({ selected: null });
        await get().refresh(true);
      },

      toggle: async (name, enabled) => {
        const previous = get().snapshot?.servers.find((server) => server.name === name);
        if (!previous || toggling.has(name)) return;
        toggling.add(name);
        patchServer(name, { status: enabled ? 'pending' : 'disabled' });
        try {
          await claudeClient.toggleMcp(name, enabled);
        } catch (error) {
          patchServer(name, { status: previous.status });
          if (/not supported/i.test(errorMessage(error))) set({ toggleSupported: false });
          throw error;
        } finally {
          toggling.delete(name);
        }
        // Re-probe so the optimistic status is replaced by the real one.
        void get().refresh(true);
      },
    };
  }),
);
