import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearSkillsCatalogCache, installSkills, parseSkillsSource, scanSkillsSource, type SkillsCatalogOptions } from './skillsCatalog';

let root: string;
let bare: string;
let home: string;
let cwd: string;
let gitCalls: string[][];

const git = (cwdDir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: cwdDir, stdio: 'pipe' });
const put = (base: string, rel: string, content: string) => {
  const path = join(base, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'skillsCatalog-'));
  const work = join(root, 'work-repo');
  mkdirSync(work);
  git(work, 'init', '-q');
  put(work, 'skills/alpha/SKILL.md', '---\nname: alpha\ndescription: The alpha skill\n---\n\nAlpha body\n');
  put(work, 'skills/alpha/ref/notes.md', 'notes');
  put(work, 'skills/beta/SKILL.md', '---\ndescription: Beta skill\n---\n');
  put(work, 'skills/Bad_Name/SKILL.md', '---\ndescription: invalid dir name\n---\n');
  put(work, 'skills/nofront/SKILL.md', 'no frontmatter here\n');
  put(work, 'skills/linky/SKILL.md', '---\ndescription: has a symlink\n---\n');
  symlinkSync('/etc/hosts', join(work, 'skills/linky/evil'));
  put(work, 'other/gamma/SKILL.md', '---\ndescription: outside skills/\n---\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  bare = join(root, 'repo.git');
  git(root, 'clone', '-q', '--bare', work, bare);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const source = () => `file://${bare}`;
const options = (extra: Partial<SkillsCatalogOptions> = {}): SkillsCatalogOptions => ({
  cwd,
  home,
  env: process.env as Record<string, string | undefined>,
  allowFileUrls: true,
  runGit: async (args, dir) => {
    gitCalls.push(args);
    return { stdout: execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString() };
  },
  ...extra,
});

beforeEach(() => {
  clearSkillsCatalogCache();
  gitCalls = [];
  const sandbox = mkdtempSync(join(root, 'case-'));
  home = join(sandbox, 'home');
  cwd = join(sandbox, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});

describe('parseSkillsSource', () => {
  test('default, shorthand with subpath, github URL, generic https URL', () => {
    expect(parseSkillsSource(undefined)).toMatchObject({ cloneUrl: 'https://github.com/anthropics/skills.git', subpath: 'skills' });
    expect(parseSkillsSource('  ')).toMatchObject({ subpath: 'skills' });
    expect(parseSkillsSource('anthropics/skills/skills/pdf')).toMatchObject({ subpath: 'skills/pdf' });
    expect(parseSkillsSource('acme/tools')).toMatchObject({ cloneUrl: 'https://github.com/acme/tools.git', subpath: '' });
    expect(parseSkillsSource('acme/tools/packs/x/')).toMatchObject({ subpath: 'packs/x' });
    expect(parseSkillsSource('https://github.com/acme/tools.git')).toMatchObject({ cloneUrl: 'https://github.com/acme/tools.git', subpath: '' });
    expect(parseSkillsSource('https://gitlab.com/acme/tools.git')).toMatchObject({ cloneUrl: 'https://gitlab.com/acme/tools.git' });
  });

  test('rejects SSH, plain http, unknown schemes, file URLs (by default), traversal and garbage', () => {
    for (const bad of ['git@github.com:a/b.git', 'ssh://git@github.com/a/b.git', 'http://github.com/a/b', 'ftp://x/y', 'file:///tmp/x.git', 'a/b/../c', '-x/y', 'justaword', 'a/b/-flag']) {
      expect(() => parseSkillsSource(bad)).toThrow();
    }
    expect(parseSkillsSource('file:///tmp/x.git', true).cloneUrl).toBe('file:///tmp/x.git');
  });
});

describe('scanSkillsSource', () => {
  test('lists every SKILL.md directory with description, installable flag and warnings', async () => {
    const result = await scanSkillsSource(options(), source());
    expect(result.source).toBe(source());
    const byName = Object.fromEntries(result.items.map((i) => [i.name, i]));
    expect(Object.keys(byName).sort()).toEqual(['Bad_Name', 'alpha', 'beta', 'gamma', 'linky', 'nofront']);
    expect(byName.alpha).toMatchObject({ dir: 'skills/alpha', description: 'The alpha skill', installable: true, installed: [] });
    expect(byName.gamma!.dir).toBe('other/gamma');
    expect(byName.Bad_Name).toMatchObject({ installable: false });
    expect(byName.Bad_Name!.warning).toContain('not a valid skill directory name');
    expect(byName.nofront).toMatchObject({ installable: true, warning: 'SKILL.md has no YAML frontmatter' });
  });

  test('reports installed scopes per skill', async () => {
    mkdirSync(join(home, '.claude', 'skills', 'alpha'), { recursive: true });
    mkdirSync(join(cwd, '.claude', 'skills', 'alpha'), { recursive: true });
    mkdirSync(join(cwd, '.claude', 'skills', 'beta'), { recursive: true });
    const { items } = await scanSkillsSource(options(), source());
    expect(items.find((i) => i.name === 'alpha')!.installed).toEqual(['user', 'project']);
    expect(items.find((i) => i.name === 'beta')!.installed).toEqual(['project']);
    expect(items.find((i) => i.name === 'gamma')!.installed).toEqual([]);
  });

  test('caches per source for 30 minutes; refresh bypasses', async () => {
    await scanSkillsSource(options(), source());
    const first = gitCalls.length;
    expect(first).toBeGreaterThan(0);
    await scanSkillsSource(options(), source());
    expect(gitCalls.length).toBe(first);
    await scanSkillsSource(options(), source(), true);
    expect(gitCalls.length).toBe(first * 2);
  });

  test('cache hits still reflect the current installed state', async () => {
    expect((await scanSkillsSource(options(), source())).items.find((i) => i.name === 'beta')!.installed).toEqual([]);
    mkdirSync(join(home, '.claude', 'skills', 'beta'), { recursive: true });
    expect((await scanSkillsSource(options(), source())).items.find((i) => i.name === 'beta')!.installed).toEqual(['user']);
  });

  test('invalid or SSH sources fail before running git; a missing repo reports a clear error', async () => {
    await expect(scanSkillsSource(options(), 'git@github.com:a/b.git')).rejects.toThrow('SSH');
    expect(gitCalls).toHaveLength(0);
    await expect(scanSkillsSource(options(), `file://${join(root, 'nope.git')}`)).rejects.toThrow();
  });

  test('git failures with auth hints become the private-repo message; temp dirs are cleaned', async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('claudekei-skills-'));
    const runGit = async () => {
      throw new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled");
    };
    await expect(scanSkillsSource(options({ runGit }), 'acme/private')).rejects.toThrow('Private repositories are not supported');
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('claudekei-skills-'))).toEqual(before);
  });

  test('a github shorthand subpath limits the scan (clone redirected to the local repo)', async () => {
    const redirect = async (args: string[], dir?: string) => {
      const mapped = args.map((a) => (a === 'https://github.com/acme/tools.git' ? source() : a));
      gitCalls.push(mapped);
      return { stdout: execFileSync('git', mapped, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString() };
    };
    const skills = await scanSkillsSource(options({ runGit: redirect }), 'acme/tools/skills');
    expect(skills.items.map((i) => i.dir).sort()).toEqual(['skills/Bad_Name', 'skills/alpha', 'skills/beta', 'skills/linky', 'skills/nofront']);
    const other = await scanSkillsSource(options({ runGit: redirect }), 'acme/tools/other');
    expect(other.items.map((i) => i.dir)).toEqual(['other/gamma']);
  });
});

describe('installSkills', () => {
  const req = (dirs: string[], extra: Partial<{ scope: 'user' | 'project'; overwrite: boolean }> = {}) => ({
    source: source(),
    dirs,
    scope: 'user' as const,
    overwrite: false,
    ...extra,
  });

  test('installs a skill directory (with supporting files) into the user root', async () => {
    const result = await installSkills(options(), req(['skills/alpha']));
    expect(result).toEqual({ installed: ['alpha'], skipped: [] });
    const target = join(home, '.claude', 'skills', 'alpha');
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('The alpha skill');
    expect(readFileSync(join(target, 'ref', 'notes.md'), 'utf8')).toBe('notes');
    expect(readdirSync(join(home, '.claude', 'skills'))).toEqual(['alpha']);
  });

  test('installs into the project root, several at once', async () => {
    const result = await installSkills(options(), req(['skills/alpha', 'other/gamma'], { scope: 'project' }));
    expect(result.installed.sort()).toEqual(['alpha', 'gamma']);
    expect(existsSync(join(cwd, '.claude', 'skills', 'gamma', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  test('skips existing skills unless overwrite; overwrite trashes first and replaces content', async () => {
    const target = join(home, '.claude', 'skills', 'alpha');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), 'local edit');
    writeFileSync(join(target, 'local-only.txt'), 'x');
    const skip = await installSkills(options(), req(['skills/alpha']));
    expect(skip).toEqual({ installed: [], skipped: [{ name: 'alpha', reason: 'Already installed' }] });
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('local edit');

    const trashed: string[] = [];
    const over = await installSkills(options({ trash: async (p) => void (trashed.push(p), rmSync(p, { recursive: true, force: true })) }), req(['skills/alpha'], { overwrite: true }));
    expect(over.installed).toEqual(['alpha']);
    expect(trashed).toEqual([target]);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('The alpha skill');
    expect(existsSync(join(target, 'local-only.txt'))).toBe(false);
  });

  test('rejects skills containing symlinks and leaves nothing behind', async () => {
    const result = await installSkills(options(), req(['skills/linky', 'skills/beta']));
    expect(result.installed).toEqual(['beta']);
    expect(result.skipped).toEqual([{ name: 'linky', reason: 'Symlinks are not supported in skills' }]);
    expect(readdirSync(join(home, '.claude', 'skills'))).toEqual(['beta']);
  });

  test('invalid names, traversal, duplicates and missing directories are skipped; nothing selected throws', async () => {
    const result = await installSkills(options(), req(['skills/Bad_Name', '../etc/evil', 'skills/beta', 'other/beta', 'skills/missing', 'skills/nofront']));
    expect(result.installed.sort()).toEqual(['beta', 'nofront']);
    const reasons = Object.fromEntries(result.skipped.map((s) => [s.name, s.reason]));
    expect(reasons['Bad_Name']).toBe('Invalid skill name');
    expect(reasons['../etc/evil']).toBe('Invalid skill directory');
    expect(reasons['beta']).toBe('Duplicate skill name in selection');
    expect(reasons['missing']).toBe('Directory not found in repository');
    await expect(installSkills(options(), req([]))).rejects.toThrow('No skills selected');
    await expect(installSkills(options(), { ...req(['skills/alpha']), scope: 'global' as never })).rejects.toThrow('scope');
  });

  test('project scope is rejected when the workspace is the home directory; no git is run when all are skipped', async () => {
    await expect(installSkills(options({ cwd: home }), req(['skills/alpha'], { scope: 'project' }))).rejects.toThrow('home directory');
    mkdirSync(join(home, '.claude', 'skills', 'alpha'), { recursive: true });
    await installSkills(options(), req(['skills/alpha']));
    expect(gitCalls).toHaveLength(0);
  });

  test('temp directories are always removed', async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('claudekei-skills-'));
    await installSkills(options(), req(['skills/alpha', 'skills/linky']));
    await scanSkillsSource(options(), source());
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('claudekei-skills-'))).toEqual(before);
  });
});
