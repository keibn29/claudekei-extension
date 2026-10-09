/**
 * Permission mode state for the composer control (docs/PHASE1_PLAN.md A1: permission mode is a
 * separate control, not an agent).
 *
 * Existing sessions: the host is the source of truth (`Session.mode`, refreshed on `session.updated`,
 * e.g. after ExitPlanMode approval). Drafts (no session yet) keep their choice here until the first send.
 */

import { create } from 'zustand';
import { getCatalog } from './bootstrapCache';
import { PERMISSION_MODES, type PermissionMode } from './types';

/**
 * Modes the keyboard/command cycle walks through (default -> acceptEdits -> plan). Bypass is a deliberate choice from
 * the dropdown only; it never comes up while cycling. `dontAsk` stays host-side only.
 */
export const COMPOSER_PERMISSION_MODES = ['default', 'acceptEdits', 'plan'] as const satisfies readonly PermissionMode[];

/** Modes selectable in the composer dropdown. */
export const PERMISSION_MENU_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const satisfies readonly PermissionMode[];

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Default',
  acceptEdits: 'Auto-accept edits',
  plan: 'Plan',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
};

export const PERMISSION_MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  default: 'Ask before editing files or running commands',
  acceptEdits: 'Apply file edits automatically, ask before running commands',
  plan: 'Plan only: explore and propose changes without editing',
  dontAsk: 'Deny anything that is not pre-approved',
  bypassPermissions: 'Run edits and commands without asking',
};

export const isPermissionModeValue = (value: unknown): value is PermissionMode =>
  typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);

/** Catalog default mode, falling back to `default`. */
export const getDefaultPermissionMode = (): PermissionMode => getCatalog()?.defaults.mode ?? 'default';

/** Next mode in the composer cycle (default -> acceptEdits -> plan -> default). */
export const nextPermissionMode = (mode: PermissionMode): PermissionMode => {
  const index = (COMPOSER_PERMISSION_MODES as readonly PermissionMode[]).indexOf(mode);
  return COMPOSER_PERMISSION_MODES[(index + 1) % COMPOSER_PERMISSION_MODES.length];
};

type DraftModeState = {
  /** Mode chosen while no session exists yet; sent with the first prompt. */
  draftMode: PermissionMode | null;
  setDraftMode: (mode: PermissionMode | null) => void;
};

export const useDraftPermissionModeStore = create<DraftModeState>()((set) => ({
  draftMode: null,
  setDraftMode: (mode) => set({ draftMode: mode }),
}));

/** Mode to show/send for the composer: the session's live mode, else the draft choice, else the default. */
export const resolveComposerMode = (sessionMode: PermissionMode | undefined, hasSession: boolean): PermissionMode => {
  if (hasSession) return sessionMode ?? getDefaultPermissionMode();
  return useDraftPermissionModeStore.getState().draftMode ?? getDefaultPermissionMode();
};
