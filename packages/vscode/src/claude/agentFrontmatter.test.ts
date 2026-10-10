import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentFrontmatter } from './agentFrontmatter';

let root: string;
let home: string;
let cwd: string;

const agent = (dir: string, file: string, front: string) => {
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'agents', file), `---\n${front}\n---\n\nBody\n`);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentFrontmatter-'));
  home = join(root, 'home');
  cwd = join(root, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('loadAgentFrontmatter', () => {
  test('reads model and effort; drops an unknown effort; keeps `inherit` as written', async () => {
    agent(cwd, 'a.md', 'name: alpha\ndescription: A\nmodel: opus\neffort: HIGH');
    agent(cwd, 'b.md', 'name: beta\ndescription: B\nmodel: inherit\neffort: turbo');
    agent(cwd, 'c.md', 'name: gamma\ndescription: C');
    const defs = await loadAgentFrontmatter({ cwd, home });
    expect(defs.get('alpha')).toEqual({ model: 'opus', effort: 'high' });
    expect(defs.get('beta')).toEqual({ model: 'inherit' });
    expect(defs.get('gamma')).toEqual({});
  });

  test('a project agent wins over a user agent of the same name', async () => {
    agent(home, 'a.md', 'name: alpha\ndescription: user\nmodel: haiku');
    agent(cwd, 'a.md', 'name: alpha\ndescription: project\nmodel: sonnet');
    const defs = await loadAgentFrontmatter({ cwd, home });
    expect(defs.get('alpha')?.model).toBe('sonnet');
  });
});
