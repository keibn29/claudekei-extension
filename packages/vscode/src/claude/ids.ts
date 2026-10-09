/**
 * Monotonically ascending id generator (docs/PHASE1_PLAN.md D6).
 *
 * The webview reducer keeps messages and parts sorted by id and uses binary search, but Claude
 * ids (uuid / toolu_ / msg_) are not chronological. The host therefore mints its own ids:
 * `<13-digit ms timestamp><4-digit sequence>`, which sort lexicographically in creation order.
 */

export type IdGenerator = {
  /**
   * Returns the next id. `atMs` is an optional timestamp hint (history replay passes the transcript
   * timestamp so ids stay close to the original time); the id never goes backwards.
   */
  next(atMs?: number): string;
};

export type IdGeneratorOptions = {
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
};

const SEQ_LIMIT = 10_000;

export function createIdGenerator(options: IdGeneratorOptions = {}): IdGenerator {
  const now = options.now ?? Date.now;
  let lastMs = 0;
  let seq = -1;

  return {
    next(atMs?: number): string {
      const requested = Math.trunc(atMs !== undefined && Number.isFinite(atMs) ? atMs : now());
      let ms = Math.max(requested, lastMs);
      if (ms === lastMs) {
        seq += 1;
        if (seq >= SEQ_LIMIT) {
          // More than 10k ids in one millisecond: borrow the next millisecond to stay ascending.
          ms += 1;
          seq = 0;
        }
      } else {
        seq = 0;
      }
      lastMs = ms;
      return `${String(ms).padStart(13, '0')}${String(seq).padStart(4, '0')}`;
    },
  };
}

/** Id of the virtual child session that represents a subagent run (`sub_<parentToolUseId>`). */
export function childSessionId(toolUseId: string): string {
  return `sub_${toolUseId}`;
}
