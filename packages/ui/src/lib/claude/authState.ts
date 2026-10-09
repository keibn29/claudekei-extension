/**
 * Claude status notices surfaced from host events:
 * - `session.error { kind: 'auth' }` / logged-out account -> "Run `claude login`" call to action;
 * - `session.error { kind: 'hook' }` -> an info notice (a user hook blocked the prompt, not a failure).
 */

import { create } from 'zustand';

export type ClaudeHookNotice = {
  id: string;
  sessionId: string | null;
  message: string;
};

export type ClaudeAuthState = {
  authRequired: boolean;
  message: string | null;
  hookNotices: ClaudeHookNotice[];
  setAuthRequired: (message?: string) => void;
  clearAuthRequired: () => void;
  addHookNotice: (sessionId: string | null, message: string) => void;
  dismissHookNotice: (id: string) => void;
};

let noticeCounter = 0;

export const useClaudeAuthStore = create<ClaudeAuthState>()((set) => ({
  authRequired: false,
  message: null,
  hookNotices: [],
  setAuthRequired: (message) => set({ authRequired: true, message: message ?? null }),
  clearAuthRequired: () => set({ authRequired: false, message: null }),
  addHookNotice: (sessionId, message) =>
    set((state) => ({
      hookNotices: [...state.hookNotices.slice(-4), { id: `hook-${Date.now()}-${noticeCounter++}`, sessionId, message }],
    })),
  dismissHookNotice: (id) => set((state) => ({ hookNotices: state.hookNotices.filter((notice) => notice.id !== id) })),
}));
