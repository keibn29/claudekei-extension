/**
 * Feature flags for OpenKei capabilities that ClaudeKei Phase 1 hides or stubs.
 *
 * Every entry point of a dropped feature checks `isFeatureEnabled(...)`, so Phase 2 re-enables a
 * feature by flipping one flag here (and implementing the backing host support).
 */

export type ClaudeFeature =
  /** Session sharing (share/unshare, copy link). */
  | 'share'
  /** Archiving sessions (Claude sessions can only be deleted). */
  | 'archive'
  /** Revert / undo / redo / timeline rewind. */
  | 'revert'
  /** Git worktree creation and worktree-bound sessions. */
  | 'worktrees'
  /** Multi-run launcher and window. */
  | 'multiRun'
  /** Agent Manager panel. */
  | 'agentManager'
  /** Provider settings, auth and model-provider management. */
  | 'providers'
  /** Quota / rate-limit displays. */
  | 'quota'
  /** Zen (OpenCode free models). */
  | 'zen'
  /** OpenCode status dialog and header indicators. */
  | 'openCodeStatus'
  /** Agents settings (create / edit / delete agent definitions). */
  | 'agentsSettings'
  /** Commands settings (CRUD of custom commands). */
  | 'commandsSettings'
  /** MCP servers UI (dropdown, settings). */
  | 'mcp'
  /** Skills settings and catalog. */
  | 'skills'
  /** Plugins settings page. */
  | 'plugins'
  /** Usage / quota settings page. */
  | 'usage'
  /** Text-to-speech and voice input. */
  | 'voice'
  /** GitHub issue / PR integration. */
  | 'github'
  /** Update check and update dialog. */
  | 'updateCheck'
  /** Scheduled tasks. */
  | 'scheduledTasks'
  /** `!` shell input mode (never entered; reserved). */
  | 'shellMode';

export const CLAUDE_FEATURES: Readonly<Record<ClaudeFeature, boolean>> = {
  share: false,
  archive: false,
  revert: false,
  worktrees: false,
  multiRun: false,
  agentManager: false,
  providers: false,
  quota: false,
  zen: false,
  openCodeStatus: false,
  agentsSettings: false,
  commandsSettings: false,
  mcp: false,
  skills: false,
  plugins: false,
  usage: false,
  voice: false,
  github: false,
  updateCheck: false,
  scheduledTasks: false,
  shellMode: false,
};

export const isFeatureEnabled = (feature: ClaudeFeature): boolean => CLAUDE_FEATURES[feature];
