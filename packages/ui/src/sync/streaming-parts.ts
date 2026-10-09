/** Legacy OpenCode part types that the host never emits and the UI never renders. */
export const SKIPPED_PART_TYPES: ReadonlySet<string> = new Set(["patch", "step-start", "step-finish"])
