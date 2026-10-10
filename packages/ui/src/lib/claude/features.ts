/**
 * Feature flags for OpenKei capabilities that ClaudeKei Phase 1 hides or stubs.
 *
 * Every entry point of a dropped feature checks `isFeatureEnabled(...)`, so Phase 2 re-enables a
 * feature by flipping one flag here (and implementing the backing host support).
 */

export type ClaudeFeature =
  /** Provider settings, auth and model-provider management. */
  | 'providers'
  /** Zen (OpenCode free models). */
  | 'zen'
  /** Update check and update dialog. */
  | 'updateCheck';

export const CLAUDE_FEATURES: Readonly<Record<ClaudeFeature, boolean>> = {
  providers: false,
  zen: false,
  updateCheck: false,
};

export const isFeatureEnabled = (feature: ClaudeFeature): boolean => CLAUDE_FEATURES[feature];
