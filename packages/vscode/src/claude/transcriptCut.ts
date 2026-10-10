/**
 * Where a transcript can be cut without splitting a tool_use from its tool_result. Shared by `fork` (SDK `forkSession`
 * `upToMessageId`) and revert (`resumeSessionAt`).
 */

type CutMessage = { id: string; role: string; claudeUuid?: string };
type CutPart = { type: string; metadata?: Record<string, unknown>; state?: { status?: string } };

/** Transcript uuid a cut may end at for this message. */
export function forkUuidOf(message: { role: string; claudeUuid?: string }, parts: readonly CutPart[]): string | undefined {
  if (message.role === 'user') return message.claudeUuid;
  const last = parts.at(-1);
  if (last?.type === 'tool') {
    // The message ends with a tool call: the cut must include its tool_result entry (unknown while still running).
    const resultUuid = last.metadata?.resultUuid;
    return typeof resultUuid === 'string' ? resultUuid : undefined;
  }
  return message.claudeUuid;
}

/** The last cuttable transcript entry strictly before `messages[index]`, or undefined when there is none. */
export function cutUuidBefore(messages: readonly CutMessage[], partsByMessage: Record<string, readonly CutPart[] | undefined>, index: number): string | undefined {
  for (let at = index - 1; at >= 0; at--) {
    const uuid = forkUuidOf(messages[at]!, partsByMessage[messages[at]!.id] ?? []);
    if (uuid) return uuid;
  }
  return undefined;
}
