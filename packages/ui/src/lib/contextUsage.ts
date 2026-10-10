import type { SessionContextUsage } from '@/stores/types/sessionTypes';

export const createEmptyContextUsage = (contextLimit: number, outputLimit: number): SessionContextUsage => ({
  totalTokens: 0,
  totalCost: 0,
  percentage: 0,
  contextLimit: contextLimit > 0 ? contextLimit : 0,
  outputLimit: outputLimit > 0 ? outputLimit : undefined,
  normalizedOutput: outputLimit > 0 ? 0 : undefined,
  thresholdLimit: contextLimit > 0 ? contextLimit : 200000,
});

export const resolveDisplayContextUsage = (
  sessionId: string | null | undefined,
  contextUsage: SessionContextUsage | null | undefined,
  contextLimit: number,
  outputLimit: number,
  lastKnown?: SessionContextUsage | null,
): SessionContextUsage | null => {
  if (!sessionId) {
    return null;
  }

  // A last known real value beats an all-zero placeholder (the ring must not drop to 0 mid-work).
  return contextUsage ?? lastKnown ?? createEmptyContextUsage(contextLimit, outputLimit);
};

/** Subagent pseudo-sessions (`sub_<callId>`) have no measurable context of their own. */
export const isSubagentSessionId = (sessionId: string | null | undefined): boolean =>
  typeof sessionId === 'string' && sessionId.startsWith('sub_');

/** Newest of two measurements by `updatedAt`; ties go to `candidate`. */
export const pickLatestContextUsage = <T extends { updatedAt: number }>(
  pushed: T | null | undefined,
  candidate: T | null | undefined,
): T | undefined => {
  if (!pushed) return candidate ?? undefined;
  if (!candidate) return pushed;
  return candidate.updatedAt >= pushed.updatedAt ? candidate : pushed;
};

