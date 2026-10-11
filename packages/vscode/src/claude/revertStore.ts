/**
 * Persistence behind revert / redo (docs/REVERT_SPEC.md D5/D6): the revert marker of a session (workspaceState).
 * Markers only; file state lives in the git snapshot store (fileHistory.ts). No vscode imports.
 */
import type { KeyValueStore } from './ClaudeSessionManager';

/**
 * `uuid`: the reverted user message; `resumeAt`: transcript uuid the next send cuts at (null = revert to the first message).
 * `head`: snapshot tree of the files right before the revert (for /redo; absent on markers written by older versions).
 * `promptIds`: `promptId`s of the reverted turns, computed once at commit so a re-applied subagent cut (crash before `init`)
 * never matches turns of the new branch.
 * `trimmedAgentIds`: subagents whose transcript the cut rewrites (known before the first rewrite, so a retried cut still
 * resets their plugin alias state).
 * `committed`: a send already made the revert permanent, but no process has announced the cut yet (`init`), so the next
 * spawn must still resume at `resumeAt` and a reload keeps the cut messages hidden. Cleared once a process emitted `init`.
 */
export type RevertMarker = { uuid: string; resumeAt: string | null; head?: string; promptIds?: string[]; trimmedAgentIds?: string[]; committed?: boolean };

export const REVERT_KEY = 'claudekei.revertMarkers';

export class RevertStore {
  constructor(private readonly kv: KeyValueStore) {}

  private markers(): Record<string, RevertMarker> {
    return this.kv.get<Record<string, RevertMarker>>(REVERT_KEY, {});
  }

  get(id: string): RevertMarker | undefined {
    return this.markers()[id];
  }

  async set(id: string, marker: RevertMarker): Promise<void> {
    await this.kv.update(REVERT_KEY, { ...this.markers(), [id]: marker });
  }

  /** Keeps a committed marker (the cut is not in the transcript yet). */
  async commit(id: string, marker: RevertMarker): Promise<void> {
    await this.kv.update(REVERT_KEY, { ...this.markers(), [id]: { ...marker, committed: true } });
  }

  async clear(id: string): Promise<void> {
    const markers = this.markers();
    if (markers[id]) {
      const { [id]: _removed, ...rest } = markers;
      await this.kv.update(REVERT_KEY, rest);
    }
  }
}
