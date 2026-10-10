/**
 * Read-only agent list for the chat UI (mention autocomplete, agent selector, TodoSendDialog).
 * Agent files are created and edited through `useClaudeConfigStore`; this store only mirrors the host catalog.
 */
import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { devtools } from "zustand/middleware";
import type { Agent } from "@/lib/claude/types";
import { claudeHost } from "@/lib/claude/host";
import { subscribeBootstrapCache } from "@/lib/claude/bootstrapCache";
import { setAgentColorOverrides } from "@/lib/agentColors";

export type AgentScope = 'user' | 'project';

// Extended Agent type for API properties not in SDK types
export type AgentWithExtras = Agent & {
  native?: boolean;
  hidden?: boolean;
  options?: { hidden?: boolean };
  scope?: AgentScope;
  /** Subfolder name parsed from file path, e.g. "business", "development" */
  group?: string;
  /** Optional UI color from frontmatter (`color`). */
  color?: string;
};

// Helper to check if agent is built-in (handles both SDK 'builtIn' and API 'native')
export const isAgentBuiltIn = (agent: Agent): boolean => {
  const extended = agent as AgentWithExtras & { builtIn?: boolean };
  return extended.native === true || extended.builtIn === true;
};

// Helper to check if agent is hidden (internal agents like title, compaction, summary)
export const isAgentHidden = (agent: Agent): boolean => {
  const extended = agent as AgentWithExtras;
  return extended.hidden === true || extended.options?.hidden === true;
};

// Helper to filter only visible (non-hidden) agents
export const filterVisibleAgents = (agents: Agent[]): Agent[] =>
  agents.filter((agent) => !isAgentHidden(agent));

const buildAgentsSignature = (agents: Agent[]): string =>
  agents
    .map((agent) => {
      const extended = agent as AgentWithExtras;
      return [
        agent.name,
        extended.scope ?? '',
        extended.group ?? '',
        extended.description ?? '',
        extended.color ?? '',
        String(extended.hidden === true),
        String(extended.native === true),
      ].join('|');
    })
    .join('||');

interface AgentsStore {
  selectedAgentName: string | null;
  agents: Agent[];
  isLoading: boolean;

  loadAgents: () => Promise<boolean>;
  getAgentByName: (name: string) => Agent | undefined;
  // Returns only visible agents (excludes hidden internal agents)
  getVisibleAgents: () => Agent[];
}

declare global {
  interface Window {
    __zustand_agents_store__?: UseBoundStore<StoreApi<AgentsStore>>;
  }
}

let loadInFlight: Promise<boolean> | null = null;

export const useAgentsStore = create<AgentsStore>()(
  devtools(
    (set, get) => ({
      selectedAgentName: null,
      agents: [],
      isLoading: false,

      loadAgents: () => {
        if (loadInFlight) return loadInFlight;
        loadInFlight = (async () => {
          set({ isLoading: true });
          try {
            const agents = await claudeHost.listAgents();
            const next = agents.map((agent) => ({ ...agent, scope: undefined, group: undefined }));
            if (buildAgentsSignature(get().agents) !== buildAgentsSignature(next)) {
              set({ agents: next, isLoading: false });
            } else {
              set({ isLoading: false });
            }
            setAgentColorOverrides(next as AgentWithExtras[]);
            return true;
          } catch {
            set({ isLoading: false });
            return false;
          } finally {
            loadInFlight = null;
          }
        })();
        return loadInFlight;
      },

      getAgentByName: (name: string) => get().agents.find((agent) => agent.name === name),

      getVisibleAgents: () => filterVisibleAgents(get().agents),
    }),
    { name: "agents-store" },
  ),
);

if (typeof window !== "undefined") {
  window.__zustand_agents_store__ = useAgentsStore;
  // The host pushes a fresh catalog after config changes; keep the mirrored list current once it was requested.
  subscribeBootstrapCache(() => {
    if (useAgentsStore.getState().agents.length > 0) {
      void useAgentsStore.getState().loadAgents();
    }
  });
}
