import { describe, expect, test } from 'bun:test';
import { pluginAliasResolver, readPluginChildren } from './pluginAliases';

const files: Record<string, string> = {
  '/h/.claude/plugins/data/claudekei-claudekei/sessions/s1.json': JSON.stringify({ children: [{ alias: 'exp-1', agentId: 'aaa', agentType: 'explorer' }, { alias: 'ora-1', agentId: 'bbb' }, { bad: true }] }),
  '/h/.claude/plugins/data/other-plugin/sessions/s1.json': JSON.stringify({ children: [{ alias: 'x-1', agentId: 'zzz' }] }),
};
const opts = {
  home: '/h',
  listDirs: () => ['claudekei-claudekei', 'other-plugin', 'kei-claudekei'],
  readFile: (p: string) => {
    if (p in files) return files[p]!;
    throw new Error('ENOENT');
  },
};

describe('pluginAliases', () => {
  test('reads claudekei plugin state only, tolerates absent files and bad entries', () => {
    expect(readPluginChildren('s1', opts)).toEqual([{ alias: 'exp-1', agentId: 'aaa' }, { alias: 'ora-1', agentId: 'bbb' }]);
    expect(readPluginChildren('missing', opts)).toEqual([]);
    expect(readPluginChildren('s1', { ...opts, listDirs: () => { throw new Error('no dir'); } })).toEqual([]);
  });

  test('resolver maps both ways', () => {
    const r = pluginAliasResolver('s1', opts);
    expect(r.forAgent('bbb')).toBe('ora-1');
    expect(r.resolve('exp-1')).toBe('aaa');
    expect(r.resolve('nope')).toBeUndefined();
  });
});
