import type { Message } from './types';

/**
 * Whether a message can be a "revert from here" target: a main-session user message that carries its
 * Claude transcript uuid and is not a subagent instruction. Never in `sub_` child sessions.
 */
export function isRevertTargetMessage(message: Message, sessionId?: string | null): boolean {
  if (message.role !== 'user') return false;
  if (sessionId?.startsWith('sub_')) return false;
  return Boolean(message.claudeUuid) && !message.instruction;
}
