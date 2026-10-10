import { describe, expect, test } from 'bun:test';
import { createMockConfigHandlers } from './mockConfig';
import type { Catalog } from './types';

const catalog = { models: [], commands: [], agents: [], primaryAgents: [], defaults: { model: 'default', mode: 'default', agent: '' } } as unknown as Catalog;
const make = () => createMockConfigHandlers({ cwd: '/mock/workspace', getCatalog: () => catalog });

describe('mock config handlers', () => {
  test('lists plugin items only for enabled plugins and flags shadowed user items', async () => {
    const h = make();
    const names = async () => (await h['claude:config.list']({})).items.map((item) => item.name);
    expect(await names()).toContain('claudekei:oracle');
    expect(await names()).toContain('claudekei:simplify');
    expect(await names()).not.toContain('superpowers:brainstorming');
    await h['claude:plugin.setEnabled']({ id: 'superpowers@superpowers-marketplace', enabled: true });
    expect(await names()).toContain('superpowers:brainstorming');
    const reviewers = (await h['claude:config.list']({})).items.filter((item) => item.kind === 'agent' && item.name === 'reviewer');
    expect(reviewers.map((item) => [item.source, item.shadowed])).toEqual([['user', true], ['project', undefined]]);
  });

  test('save creates, rejects duplicates, updates keeping unrelated fields, and delete removes', async () => {
    const h = make();
    const base = { kind: 'agent', scope: 'user', name: 'helper', create: true, fields: { description: 'Helps', color: 'red' }, body: 'Hi' } as const;
    const saved = await h['claude:config.save'](base);
    expect(saved.path).toBe('/Users/mock/.claude/agents/helper.md');
    expect(() => h['claude:config.save'](base)).toThrow('already exists in user');
    await h['claude:config.save']({ ...base, create: false, fields: { description: 'Helps', color: '' }, body: 'Updated' });
    const detail = await h['claude:config.read']({ path: saved.path });
    expect(detail.fields).toEqual({ description: 'Helps' });
    expect(detail.body).toBe('Updated');
    await h['claude:config.delete']({ path: saved.path });
    expect(() => h['claude:config.read']({ path: saved.path })).toThrow('not found');
  });

  test('mcp toggle, save and remove mutate the status snapshot', async () => {
    const h = make();
    const find = async (name: string) => (await h['claude:mcp.status']({})).servers.find((server) => server.name === name);
    await h['claude:mcp.toggle']({ name: 'github', enabled: false });
    expect((await find('github'))?.status).toBe('disabled');
    await h['claude:mcp.toggle']({ name: 'github', enabled: true });
    expect((await find('github'))?.status).toBe('connected');
    expect((await find('docs-search'))?.status).toBe('pending');
    expect((await h['claude:mcp.status']({ refresh: true })).servers.find((server) => server.name === 'docs-search')?.status).toBe('connected');
    await h['claude:mcp.save']({ name: 'new-one', scope: 'user', create: true, config: { type: 'stdio', command: 'node' } });
    expect((await find('new-one'))?.scope).toBe('user');
    expect(() => h['claude:mcp.save']({ name: 'p', scope: 'project', create: true, config: { type: 'http', url: 'http://x' } })).toThrow('.mcp.json');
    await h['claude:mcp.remove']({ name: 'new-one', scope: 'user' });
    expect(await find('new-one')).toBeUndefined();
  });

  test('skills catalog reports installed scopes; install skips existing unless overwrite', async () => {
    const h = make();
    const first = await h['claude:skills.install']({ source: 'anthropics/skills', dirs: ['pdf', 'Brand Guidelines'], scope: 'user', overwrite: false });
    expect(first.installed).toEqual(['pdf']);
    expect(first.skipped.map((s) => s.name)).toEqual(['Brand Guidelines']);
    const again = await h['claude:skills.install']({ source: 'anthropics/skills', dirs: ['pdf'], scope: 'user', overwrite: false });
    expect(again.skipped).toEqual([{ name: 'pdf', reason: 'Already installed' }]);
    expect((await h['claude:skills.install']({ source: 'anthropics/skills', dirs: ['pdf'], scope: 'user', overwrite: true })).installed).toEqual(['pdf']);
    const catalogResult = await h['claude:skills.catalog']({});
    expect(catalogResult.items.find((item) => item.dir === 'pdf')?.installed).toEqual(['user']);
    expect(() => h['claude:skills.catalog']({ source: 'git@github.com:a/b.git' })).toThrow('HTTPS');
  });

  test('usage activity has day and week windows', async () => {
    const activity = await make()['claude:usage.activity']({});
    expect(activity?.day.requests).toBeLessThan(activity?.week.requests ?? 0);
  });
});
