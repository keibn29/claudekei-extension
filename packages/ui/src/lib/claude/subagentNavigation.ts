/**
 * Cross-session jump from a subagent child session back to the parent tool call that sent an instruction
 * (docs/PHASE1_1_UI_SPEC.md 1.6 "View in <Parent>"). The child view records the target here, switches to the
 * parent session, and the parent's chat container scrolls to the tool part once it is mounted.
 */

import { create } from 'zustand';

export type SubagentJumpTarget = {
  /** Parent session to land in. */
  sessionId: string;
  /** Parent message holding the tool part (used to mount virtualized rows). */
  messageId?: string;
  /** `Agent` / `SendMessage` tool call id (`ToolPart.callID`). */
  toolCallId: string;
};

type SubagentNavigationState = {
  pendingJump: SubagentJumpTarget | null;
  requestJump: (target: SubagentJumpTarget) => void;
  clearJump: () => void;
};

export const useSubagentNavigationStore = create<SubagentNavigationState>()((set) => ({
  pendingJump: null,
  requestJump: (target) => set({ pendingJump: target }),
  clearJump: () => set({ pendingJump: null }),
}));
