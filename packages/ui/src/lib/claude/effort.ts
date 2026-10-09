/**
 * Effort (reasoning level) state for the composer, mirroring `permissionMode.ts`.
 *
 * Existing sessions: the host is the source of truth (`Session.effort`, refreshed on `session.updated`, including the
 * agent's default effort applied on `setAgent`). Drafts keep their choice here until the first send; `undefined` means
 * "follow the selected agent's default".
 */

import { create } from 'zustand';
import { getCatalog } from './bootstrapCache';
import type { EffortLevel } from './types';

/** Window event the "cycle thinking variant" shortcut dispatches; the composer's model controls cycle the effort. */
export const CYCLE_EFFORT_EVENT = 'claudekei:cycle-effort';

type DraftEffortState = {
  /** `undefined` = follow the agent default, `null` = model default (explicit), otherwise a level. */
  draftEffort: EffortLevel | null | undefined;
  setDraftEffort: (effort: EffortLevel | null | undefined) => void;
};

export const useDraftEffortStore = create<DraftEffortState>()((set) => ({
  draftEffort: undefined,
  setDraftEffort: (effort) => set({ draftEffort: effort }),
}));

/** Effort to show/send for the composer. `null` = model default. */
export const resolveComposerEffort = (params: {
  hasSession: boolean;
  sessionEffort?: EffortLevel;
  draftEffort: EffortLevel | null | undefined;
  agentDefaultEffort?: EffortLevel;
  catalogDefaultEffort?: EffortLevel;
}): EffortLevel | null => {
  if (params.hasSession) return params.sessionEffort ?? null;
  if (params.draftEffort !== undefined) return params.draftEffort;
  return params.agentDefaultEffort ?? params.catalogDefaultEffort ?? null;
};

/** Effort a draft would send/show right now for `agent`, using the catalog's per-agent and global defaults. */
export const resolveDraftEffort = (agent: string | undefined): EffortLevel | null => {
  const catalog = getCatalog();
  const info = agent ? catalog?.primaryAgents.find((candidate) => candidate.name === agent) : undefined;
  return resolveComposerEffort({
    hasSession: false,
    draftEffort: useDraftEffortStore.getState().draftEffort,
    agentDefaultEffort: info?.defaultEffort,
    catalogDefaultEffort: catalog?.defaults.effort,
  });
};
