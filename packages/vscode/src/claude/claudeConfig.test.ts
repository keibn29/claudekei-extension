import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteConfigItem, listConfig, readConfigItem, saveConfigItem, type ConfigFsOptions } from './claudeConfig';

let root: string;
let home: string;
let cwd: string;

const write = (path: string, content: string): string => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
};
const md = (front: string, body = 'Body\n'): string => `---\n${front}\n---\n\n${body}`;
const opts = (extra: Partial<ConfigFsOptions> = {}): ConfigFsOptions => ({ cwd, home, ...extra });
const userDir = () => join(home, '.claude');
const projectDir = () => join(cwd, '.claude');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claudeConfig-'));
  home = join(root, 'home');
  cwd = join(root, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const installPlugin = (id: string, installs: unknown[], manifest = { name: 'demo', version: '1.2.3', description: 'Demo plugin' }) => {
  write(join(userDir(), 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [id]: installs } }));
  const installPath = (installs[0] as { installPath: string }).installPath;
  write(join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest));
  return installPath;
};

describe('listConfig', () => {
  test('scans agents (nested), commands (nested, group) and depth-1 skills; skips dot-dirs and synced', async () => {
    write(join(userDir(), 'agents', 'a.md'), md('description: Agent A\nname: alpha'));
    write(join(userDir(), 'agents', 'team', 'b.md'), md('description: Agent B'));
    write(join(userDir(), 'agents', '.trash', 'dead.md'), md('description: dead'));
    write(join(userDir(), 'commands', 'ship.md'), md('description: Ship it'));
    write(join(userDir(), 'commands', 'git', 'sync.md'), md('description: Sync'));
    write(join(userDir(), 'skills', 'my-skill', 'SKILL.md'), md('name: my-skill\ndescription: A skill'));
    write(join(userDir(), 'skills', '.trash', 'old', 'SKILL.md'), md('description: trashed'));
    write(join(userDir(), 'skills', 'synced', 'x', 'SKILL.md'), md('description: synced'));
    write(join(userDir(), 'skills', 'my-skill', 'nested', 'SKILL.md'), md('description: too deep'));

    const { items } = await listConfig(opts());
    const summary = items.map((i) => `${i.kind}:${i.name}:${i.source}:${i.group ?? ''}`).sort();
    expect(summary).toEqual([
      'agent:alpha:user:',
      'agent:b:user:',
      'command:ship:user:',
      'command:sync:user:git',
      'skill:my-skill:user:',
    ]);
    expect(items.find((i) => i.name === 'alpha')?.description).toBe('Agent A');
  });

  test('follows a symlinked skill directory (npx skills layout)', async () => {
    write(join(home, '.agents', 'skills', 'linked', 'SKILL.md'), md('name: linked\ndescription: Linked skill'));
    mkdirSync(join(userDir(), 'skills'), { recursive: true });
    symlinkSync(join(home, '.agents', 'skills', 'linked'), join(userDir(), 'skills', 'linked'));
    const { items } = await listConfig(opts());
    expect(items.map((i) => i.name)).toEqual(['linked']);
    const detail = await readConfigItem(opts(), join(userDir(), 'skills', 'linked', 'SKILL.md'));
    expect(detail.fields.description).toBe('Linked skill');
  });

  test('project items shadow user items with the same kind and name', async () => {
    write(join(userDir(), 'agents', 'dup.md'), md('description: user'));
    write(join(projectDir(), 'agents', 'dup.md'), md('description: project'));
    write(join(userDir(), 'commands', 'dup.md'), md('description: only user'));
    const { items } = await listConfig(opts());
    const agents = items.filter((i) => i.name === 'dup' && i.kind === 'agent');
    expect(agents.map((i) => [i.source, i.shadowed])).toEqual([
      ['project', undefined],
      ['user', true],
    ]);
    expect(items.find((i) => i.kind === 'command')?.shadowed).toBeUndefined();
  });

  test('invalid YAML is listed with an error', async () => {
    write(join(userDir(), 'agents', 'broken.md'), '---\nfoo: [unclosed\n---\n\nBody');
    const { items } = await listConfig(opts());
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe('broken');
    expect(items[0]!.error).toContain('Invalid YAML');
  });

  test('cwd === home does not duplicate items and has no project root', async () => {
    write(join(userDir(), 'agents', 'only.md'), md('description: once'));
    const snapshot = await listConfig({ cwd: home, home });
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.claudekeiFiles.map((f) => f.scope)).toEqual(['user']);
    await expect(saveConfigItem({ cwd: home, home }, { kind: 'agent', scope: 'project', name: 'x', create: true, fields: { description: 'd' }, body: '' })).rejects.toThrow('home directory');
  });

  test('plugins: only enabled plugins contribute prefixed items; projectPath filter; enabledPlugins merge', async () => {
    const installPath = join(userDir(), 'plugins', 'cache', 'demo');
    write(join(installPath, 'agents', 'oracle.md'), md('description: Plugin oracle'));
    write(join(installPath, 'agents', 'deep', 'ignored.md'), md('description: nested plugin agents are not scanned'));
    write(join(installPath, 'commands', 'grp', 'run.md'), md('description: Run'));
    write(join(installPath, 'skills', 'helper', 'SKILL.md'), md('description: Helper'));
    installPlugin('demo@market', [{ scope: 'user', installPath, version: '1.0.0' }]);
    write(join(userDir(), 'plugins', 'known_marketplaces.json'), JSON.stringify({ market: { source: { source: 'github', repo: 'o/r' }, installLocation: '/x', lastUpdated: '2026-10-09T22:42:23.417Z' } }));

    // not enabled
    let snapshot = await listConfig(opts());
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.plugins).toMatchObject([{ id: 'demo@market', name: 'demo', marketplace: 'market', version: '1.2.3', description: 'Demo plugin', scope: 'user', enabled: false }]);
    expect(snapshot.marketplaces).toEqual([{ name: 'market', source: 'o/r', installLocation: '/x', lastUpdated: Date.parse('2026-10-09T22:42:23.417Z') }]);

    // enabled in user settings, disabled again by project settings (later wins), re-enabled by settings.local.json
    write(join(userDir(), 'settings.json'), '{ // comment\n "enabledPlugins": { "demo@market": true } }');
    snapshot = await listConfig(opts());
    expect(snapshot.items.map((i) => `${i.kind}:${i.name}`).sort()).toEqual(['agent:demo:oracle', 'command:demo:run', 'skill:demo:helper']);
    expect(snapshot.items.every((i) => i.source === 'plugin' && i.plugin === 'demo@market')).toBe(true);
    write(join(projectDir(), 'settings.json'), JSON.stringify({ enabledPlugins: { 'demo@market': false } }));
    expect((await listConfig(opts())).items).toHaveLength(0);
    write(join(projectDir(), 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'demo@market': true } }));
    expect((await listConfig(opts())).items).toHaveLength(3);
  });

  test('plugin installs scoped to another project are ignored', async () => {
    const installPath = join(userDir(), 'plugins', 'cache', 'proj');
    installPlugin('proj@m', [{ scope: 'project', installPath, projectPath: join(root, 'elsewhere') }]);
    expect((await listConfig(opts())).plugins).toHaveLength(0);
    installPlugin('proj@m', [{ scope: 'project', installPath, projectPath: cwd }]);
    expect((await listConfig(opts())).plugins.map((p) => p.scope)).toEqual(['project']);
  });

  test('claudekeiFiles and projectMcpFile report existence', async () => {
    write(join(projectDir(), 'claudekei.jsonc'), '{}');
    const snapshot = await listConfig(opts());
    expect(snapshot.claudekeiFiles).toEqual([
      { scope: 'user', path: join(userDir(), 'claudekei.jsonc'), exists: false },
      { scope: 'project', path: join(projectDir(), 'claudekei.jsonc'), exists: true },
    ]);
    expect(snapshot.projectMcpFile).toEqual({ path: join(cwd, '.mcp.json'), exists: false });
  });
});

describe('readConfigItem', () => {
  test('returns fields (arrays joined), otherKeys and body', async () => {
    const path = write(
      join(userDir(), 'agents', 'planner.md'),
      md('name: planner\ndescription: Plans\nmodel: opus\neffort: high\ntools:\n  - Read\n  - Grep\nskills:\n  - x\nhooks: {}', '\n\nDo things\n'),
    );
    const detail = await readConfigItem(opts(), path);
    expect(detail.fields).toEqual({ description: 'Plans', model: 'opus', effort: 'high', tools: 'Read, Grep' });
    expect(detail.otherKeys).toEqual(['skills', 'hooks']);
    expect(detail.body).toBe('Do things\n');
    expect(detail.name).toBe('planner');
  });

  test('skills list supporting files without symlinks and without SKILL.md', async () => {
    const path = write(join(userDir(), 'skills', 's', 'SKILL.md'), md('description: S'));
    write(join(userDir(), 'skills', 's', 'ref', 'a.md'), 'a');
    write(join(userDir(), 'skills', 's', 'b.txt'), 'b');
    symlinkSync('/etc/hosts', join(userDir(), 'skills', 's', 'link.txt'));
    const detail = await readConfigItem(opts(), path);
    expect(detail.files).toEqual([join(userDir(), 'skills', 's', 'b.txt'), join(userDir(), 'skills', 's', 'ref', 'a.md')]);
  });

  test('reads enabled plugin items, rejects disabled plugin and unrelated paths', async () => {
    const installPath = join(userDir(), 'plugins', 'cache', 'demo');
    const agent = write(join(installPath, 'agents', 'oracle.md'), md('description: Plugin oracle'));
    installPlugin('demo@market', [{ scope: 'user', installPath }]);
    await expect(readConfigItem(opts(), agent)).rejects.toThrow('Not a Claude config item path');
    write(join(userDir(), 'settings.json'), JSON.stringify({ enabledPlugins: { 'demo@market': true } }));
    const detail = await readConfigItem(opts(), agent);
    expect(detail).toMatchObject({ name: 'demo:oracle', source: 'plugin', plugin: 'demo@market' });
    await expect(readConfigItem(opts(), join(userDir(), 'settings.json'))).rejects.toThrow('Not a Claude config item path');
    await expect(readConfigItem(opts(), '/etc/passwd')).rejects.toThrow();
    await expect(readConfigItem(opts(), 'relative.md')).rejects.toThrow('absolute');
  });

  test('rejects traversal and symlinks escaping the config directory', async () => {
    write(join(root, 'secret.md'), md('description: secret'));
    await expect(readConfigItem(opts(), join(userDir(), 'agents', '..', '..', 'secret.md'))).rejects.toThrow();
    mkdirSync(join(userDir(), 'agents'), { recursive: true });
    symlinkSync(root, join(userDir(), 'agents', 'escape'));
    await expect(readConfigItem(opts(), join(userDir(), 'agents', 'escape', 'secret.md'))).rejects.toThrow('escapes');
  });
});

describe('symlinked item files', () => {
  test('a repository command symlinked to a file outside the root is neither listed, read, saved nor deleted', async () => {
    const secret = write(join(home, '.aws', 'credentials.md'), md('description: aws-secret-key', 'TOP SECRET\n'));
    mkdirSync(join(projectDir(), 'commands'), { recursive: true });
    mkdirSync(join(projectDir(), 'agents'), { recursive: true });
    symlinkSync(secret, join(projectDir(), 'commands', 'x.md'));
    symlinkSync(secret, join(projectDir(), 'agents', 'y.md'));
    const listed = await listConfig(opts());
    expect(listed.items.map((i) => i.name)).toEqual([]);
    expect(JSON.stringify(listed)).not.toContain('aws-secret-key');
    for (const path of [join(projectDir(), 'commands', 'x.md'), join(projectDir(), 'agents', 'y.md')]) {
      await expect(readConfigItem(opts(), path)).rejects.toThrow('escapes');
      await expect(deleteConfigItem(opts(), path)).rejects.toThrow('escapes');
    }
    await expect(saveConfigItem(opts(), { kind: 'command', scope: 'project', name: 'x', create: false, fields: { description: 'pwned' }, body: 'x' })).rejects.toThrow('escapes');
    expect(readFileSync(secret, 'utf8')).toContain('TOP SECRET');
  });

  test('a symlinked agents directory in a repository cannot expose files elsewhere', async () => {
    write(join(root, 'docs', 'notes.md'), md('description: private notes'));
    mkdirSync(projectDir(), { recursive: true });
    symlinkSync(join(root, 'docs'), join(projectDir(), 'agents'));
    expect((await listConfig(opts())).items).toEqual([]);
    await expect(readConfigItem(opts(), join(projectDir(), 'agents', 'notes.md'))).rejects.toThrow('escapes');
  });

  test('a symlink that stays inside the config root still works', async () => {
    write(join(projectDir(), 'commands', 'real.md'), md('description: real'));
    symlinkSync(join(projectDir(), 'commands', 'real.md'), join(projectDir(), 'commands', 'alias.md'));
    const { items } = await listConfig(opts());
    expect(items.map((i) => i.name).sort()).toEqual(['alias', 'real']);
    expect((await readConfigItem(opts(), join(projectDir(), 'commands', 'alias.md'))).fields.description).toBe('real');
  });

  test('even in the user root a single file symlinked outside commands/ is not followed (symlink the directory instead)', async () => {
    const target = write(join(home, 'dotfiles', 'ship.md'), md('description: dotfile ship'));
    mkdirSync(join(userDir(), 'commands'), { recursive: true });
    symlinkSync(target, join(userDir(), 'commands', 'ship.md'));
    expect((await listConfig(opts())).items.map((i) => i.name)).toEqual([]);
  });
});

describe('saveConfigItem', () => {
  test('create writes name first, only set fields, and returns the item', async () => {
    const item = await saveConfigItem(opts(), { kind: 'agent', scope: 'user', name: 'new-agent', create: true, fields: { description: 'Does stuff', model: 'inherit', effort: '', color: 'blue', tools: '' }, body: '\n\nHello\n' });
    expect(item).toMatchObject({ kind: 'agent', name: 'new-agent', source: 'user', description: 'Does stuff' });
    const text = readFileSync(join(userDir(), 'agents', 'new-agent.md'), 'utf8');
    expect(text).toBe('---\nname: new-agent\ndescription: Does stuff\nmodel: inherit\ncolor: blue\n---\n\nHello\n');
    expect(readdirSync(join(userDir(), 'agents'))).toEqual(['new-agent.md']);
  });

  test('create skill uses SKILL.md in a named dir; commands have no name key', async () => {
    await saveConfigItem(opts(), { kind: 'skill', scope: 'project', name: 'my-skill', create: true, fields: { description: 'S', 'allowed-tools': 'Read' }, body: 'x' });
    expect(readFileSync(join(projectDir(), 'skills', 'my-skill', 'SKILL.md'), 'utf8')).toBe('---\nname: my-skill\ndescription: S\nallowed-tools: Read\n---\n\nx');
    await saveConfigItem(opts(), { kind: 'command', scope: 'user', name: 'go', create: true, fields: { 'argument-hint': '<x>' }, body: 'Run $ARGUMENTS' });
    expect(readFileSync(join(userDir(), 'commands', 'go.md'), 'utf8')).toBe("---\nargument-hint: <x>\n---\n\nRun $ARGUMENTS");
  });

  test('update keeps unknown keys, comments and untouched list values; deletes emptied keys', async () => {
    const path = write(
      join(userDir(), 'agents', 'keep.md'),
      '---\n# leading comment\nname: keep\ndescription: Old\ntools:\n  - Read\n  - Grep\nskills:\n  - helper # trailing comment\nmodel: opus\n---\n\nOld body\n',
    );
    await saveConfigItem(opts(), { kind: 'agent', scope: 'user', name: 'keep', create: false, fields: { description: 'New', tools: 'Read, Grep', model: '', effort: 'low' }, body: 'New body' });
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('# leading comment');
    expect(text).toContain('- helper # trailing comment');
    expect(text).toContain('tools:\n  - Read\n  - Grep');
    expect(text).toContain('description: New');
    expect(text).not.toContain('model:');
    expect(text).toContain('effort: low');
    expect(text.endsWith('---\n\nNew body')).toBe(true);
    expect((await readConfigItem(opts(), path)).otherKeys).toEqual(['skills']);
  });

  test('a file without frontmatter gets one; description may stay for commands', async () => {
    const path = write(join(userDir(), 'commands', 'plain.md'), 'Just a template\n');
    await saveConfigItem(opts(), { kind: 'command', scope: 'user', name: 'plain', create: false, fields: { description: 'Now documented' }, body: 'Just a template\n' });
    expect(readFileSync(path, 'utf8')).toBe('---\ndescription: Now documented\n---\n\nJust a template\n');
  });

  test('create on existing fails; update on missing fails; invalid frontmatter cannot be saved over', async () => {
    write(join(userDir(), 'agents', 'there.md'), md('description: x'));
    await expect(saveConfigItem(opts(), { kind: 'agent', scope: 'user', name: 'there', create: true, fields: { description: 'd' }, body: '' })).rejects.toThrow('agent there already exists in user');
    await expect(saveConfigItem(opts(), { kind: 'agent', scope: 'user', name: 'gone', create: false, fields: { description: 'd' }, body: '' })).rejects.toThrow('does not exist');
    write(join(userDir(), 'agents', 'bad.md'), '---\nfoo: [unclosed\n---\n');
    await expect(saveConfigItem(opts(), { kind: 'agent', scope: 'user', name: 'bad', create: false, fields: { description: 'd' }, body: '' })).rejects.toThrow('Invalid YAML');
    write(join(userDir(), 'skills', 'dir-exists', 'other.txt'), 'x');
    await expect(saveConfigItem(opts(), { kind: 'skill', scope: 'user', name: 'dir-exists', create: true, fields: { description: 'd' }, body: '' })).rejects.toThrow('already exists');
  });

  test('validation: name, fields, description, effort, color, body size', async () => {
    const base = { kind: 'agent', scope: 'user', name: 'ok', create: true, fields: { description: 'd' }, body: '' } as const;
    for (const name of ['', 'Upper', '-lead', '../evil', 'a/b', 'a'.repeat(65)]) {
      await expect(saveConfigItem(opts(), { ...base, name })).rejects.toThrow('Name must be');
    }
    await expect(saveConfigItem(opts(), { ...base, fields: { description: 'd', 'argument-hint': 'x' } })).rejects.toThrow('not supported for agent');
    await expect(saveConfigItem(opts(), { ...base, fields: { description: '  ' } })).rejects.toThrow('Description is required');
    await expect(saveConfigItem(opts(), { ...base, kind: 'skill', fields: {} })).rejects.toThrow('Description is required');
    await expect(saveConfigItem(opts(), { ...base, fields: { description: 'd', effort: 'turbo' } })).rejects.toThrow('Invalid effort');
    await expect(saveConfigItem(opts(), { ...base, fields: { description: 'd', color: 'magenta' } })).rejects.toThrow('Invalid color');
    await expect(saveConfigItem(opts(), { ...base, body: 'x'.repeat(1024 * 1024 + 1) })).rejects.toThrow('1 MB');
    await expect(saveConfigItem(opts(), { ...base, scope: 'global' as never })).rejects.toThrow('scope');
    expect(existsSync(join(userDir(), 'agents'))).toBe(false);
  });

  test('refuses to write through a symlinked agents directory escaping the root', async () => {
    mkdirSync(join(root, 'outside'), { recursive: true });
    mkdirSync(userDir(), { recursive: true });
    symlinkSync(join(root, 'outside'), join(userDir(), 'agents'));
    // The agents dir itself being a symlink is the user's choice and its target becomes the base.
    await saveConfigItem(opts(), { kind: 'agent', scope: 'user', name: 'via-link', create: true, fields: { description: 'd' }, body: '' });
    expect(existsSync(join(root, 'outside', 'via-link.md'))).toBe(true);
    // ...but an entry inside it pointing elsewhere is rejected.
    symlinkSync(join(root, 'home'), join(root, 'outside', 'sub'));
    write(join(root, 'home', 'x.md'), md('description: x'));
    await expect(readConfigItem(opts(), join(userDir(), 'agents', 'sub', 'x.md'))).rejects.toThrow('escapes');
  });

  test('plugin items cannot be saved or deleted', async () => {
    const installPath = join(userDir(), 'plugins', 'cache', 'demo');
    const agent = write(join(installPath, 'agents', 'oracle.md'), md('description: p'));
    installPlugin('demo@market', [{ scope: 'user', installPath }]);
    write(join(userDir(), 'settings.json'), JSON.stringify({ enabledPlugins: { 'demo@market': true } }));
    await expect(deleteConfigItem(opts(), agent)).rejects.toThrow('Not a Claude config item path');
    expect(existsSync(agent)).toBe(true);
  });
});

describe('deleteConfigItem', () => {
  test('agents/commands trash the file; skills trash the directory', async () => {
    const trashed: string[] = [];
    const trash = async (p: string) => void trashed.push(p);
    const agent = write(join(userDir(), 'agents', 'a.md'), md('description: a'));
    const command = write(join(projectDir(), 'commands', 'g', 'c.md'), md('description: c'));
    const skill = write(join(userDir(), 'skills', 's', 'SKILL.md'), md('description: s'));
    await deleteConfigItem(opts({ trash }), agent);
    await deleteConfigItem(opts({ trash }), command);
    await deleteConfigItem(opts({ trash }), skill);
    expect(trashed).toEqual([agent, command, join(userDir(), 'skills', 's')]);
  });

  test('default trash removes from disk; unknown or traversal paths are rejected', async () => {
    const skill = write(join(userDir(), 'skills', 's', 'SKILL.md'), md('description: s'));
    write(join(userDir(), 'skills', 's', 'extra.txt'), 'x');
    await deleteConfigItem(opts(), skill);
    expect(existsSync(join(userDir(), 'skills', 's'))).toBe(false);
    await expect(deleteConfigItem(opts(), join(userDir(), 'agents', 'missing.md'))).rejects.toThrow('Not found');
    await expect(deleteConfigItem(opts(), join(userDir(), 'settings.json'))).rejects.toThrow('Not a Claude config item path');
    await expect(deleteConfigItem(opts(), join(userDir(), 'agents', '..', 'settings.json'))).rejects.toThrow();
  });

  test('deleting a symlinked skill removes only the link', async () => {
    write(join(home, '.agents', 'skills', 'linked', 'SKILL.md'), md('description: l'));
    mkdirSync(join(userDir(), 'skills'), { recursive: true });
    symlinkSync(join(home, '.agents', 'skills', 'linked'), join(userDir(), 'skills', 'linked'));
    await deleteConfigItem(opts(), join(userDir(), 'skills', 'linked', 'SKILL.md'));
    expect(existsSync(join(userDir(), 'skills', 'linked'))).toBe(false);
    expect(existsSync(join(home, '.agents', 'skills', 'linked', 'SKILL.md'))).toBe(true);
  });
});
