/**
 * Context window usage (SDK `Query.getContextUsage`) mapped to the webview contract (`ContextUsage`), plus a cheap
 * estimate for sessions without a live process.
 */
import type { ContextCategory, ContextCategoryKind, ContextUsage, ContextUsageItem, ContextUsageSection } from '@openchamber/ui/src/lib/claude/types';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Largest lists are cut here; the detail view is a summary, not a dump. */
export const MAX_SECTION_ITEMS = 20;
/** Window assumed for an estimate when no measurement exists yet. */
export const FALLBACK_CONTEXT_WINDOW = 200_000;

const KINDS: readonly ContextCategoryKind[] = ['used', 'free', 'buffer', 'deferred'];

export const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'other';

const section = (id: string, label: string, items: ContextUsageItem[]): ContextUsageSection | undefined => {
  const kept = items.filter((i) => i.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, MAX_SECTION_ITEMS);
  return kept.length > 0 ? { id, label, items: kept } : undefined;
};

/** Maps the SDK response; returns undefined when it has no usable totals. */
export function toContextUsage(raw: unknown, now: number, source: ContextUsage['source'] = 'exact'): ContextUsage | undefined {
  if (!isRec(raw)) return undefined;
  const maxTokens = num(raw.maxTokens);
  const usedTokens = num(raw.totalTokens);
  if (maxTokens === undefined || usedTokens === undefined || maxTokens <= 0) return undefined;

  const categories: ContextCategory[] = [];
  for (const c of arr(raw.categories)) {
    if (!isRec(c)) continue;
    const label = str(c.name);
    const tokens = num(c.tokens);
    if (!label || tokens === undefined) continue;
    const kind = KINDS.includes(c.kind as ContextCategoryKind) ? (c.kind as ContextCategoryKind) : 'used';
    categories.push({ id: slug(label), label, tokens, kind, ...(str(c.color) ? { color: str(c.color) } : {}) });
  }

  const sections = [
    section('memory-files', 'Memory files', arr(raw.memoryFiles).filter(isRec).map((m) => ({ name: str(m.path) ?? 'file', tokens: num(m.tokens) ?? 0, ...(str(m.type) ? { detail: str(m.type) } : {}) }))),
    section('mcp-tools', 'MCP tools', arr(raw.mcpTools).filter(isRec).map((m) => ({ name: str(m.name) ?? 'tool', tokens: num(m.tokens) ?? 0, ...(str(m.serverName) ? { detail: str(m.serverName) } : {}) }))),
    section('custom-agents', 'Custom agents', arr(raw.agents).filter(isRec).map((a) => ({ name: str(a.agentType) ?? 'agent', tokens: num(a.tokens) ?? 0, ...(str(a.source) ? { detail: str(a.source) } : {}) }))),
    section('skills', 'Skills', arr(isRec(raw.skills) ? raw.skills.skillFrontmatter : []).filter(isRec).map((s) => ({ name: str(s.name) ?? 'skill', tokens: num(s.tokens) ?? 0, ...(str(s.source) ? { detail: str(s.source) } : {}) }))),
    section('system-tools', 'System tools', arr(raw.systemTools).filter(isRec).map((t) => ({ name: str(t.name) ?? 'tool', tokens: num(t.tokens) ?? 0 }))),
    section('system-prompt', 'System prompt', arr(raw.systemPromptSections).filter(isRec).map((t) => ({ name: str(t.name) ?? 'section', tokens: num(t.tokens) ?? 0 }))),
  ];
  const mb = raw.messageBreakdown;
  if (isRec(mb)) {
    sections.push(
      section('messages', 'Messages', [
        { name: 'Tool calls', tokens: num(mb.toolCallTokens) ?? 0 },
        { name: 'Tool results', tokens: num(mb.toolResultTokens) ?? 0 },
        { name: 'Attachments', tokens: num(mb.attachmentTokens) ?? 0 },
        { name: 'Assistant messages', tokens: num(mb.assistantMessageTokens) ?? 0 },
        { name: 'User messages', tokens: num(mb.userMessageTokens) ?? 0 },
      ]),
    );
  }

  const buffer = categories.find((c) => c.kind === 'buffer');
  const threshold = num(raw.autoCompactThreshold);
  return {
    usedTokens,
    maxTokens,
    percent: Math.round((usedTokens / maxTokens) * 1000) / 10,
    ...(buffer ? { autocompactBufferTokens: buffer.tokens } : {}),
    ...(threshold !== undefined ? { autocompactThresholdTokens: threshold } : {}),
    ...(typeof raw.isAutoCompactEnabled === 'boolean' ? { autocompactEnabled: raw.isAutoCompactEnabled } : {}),
    ...(str(raw.model) ? { model: str(raw.model) } : {}),
    categories,
    ...(sections.some(Boolean) ? { sections: sections.filter((s): s is ContextUsageSection => !!s) } : {}),
    updatedAt: now,
    source,
  };
}

/**
 * Estimate for a session without a measurement: everything counted is "Messages" (the last response's prompt size),
 * the rest is free. `previous` supplies the window size when an earlier measurement exists.
 */
export function estimateContextUsage(tokens: number, now: number, previous?: ContextUsage): ContextUsage {
  const maxTokens = previous?.maxTokens ?? FALLBACK_CONTEXT_WINDOW;
  const used = Math.max(0, Math.min(tokens, maxTokens));
  return {
    usedTokens: used,
    maxTokens,
    percent: Math.round((used / maxTokens) * 1000) / 10,
    ...(previous?.model ? { model: previous.model } : {}),
    categories: [
      { id: 'messages', label: 'Messages', tokens: used, kind: 'used' },
      { id: 'free-space', label: 'Free space', tokens: maxTokens - used, kind: 'free' },
    ],
    updatedAt: now,
    source: 'estimate',
  };
}
