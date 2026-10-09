import { describe, expect, test } from 'bun:test';
import { buildCatalog, derivePrimaryAgents, looksLoggedOut, probeCatalog, probeFromInit } from './catalog';
import { FakeQuery, STUB_INIT } from './fakes';

const agents = [
  { name: 'general-purpose', description: 'General' },
  { name: 'claudekei:sprinter', description: 'Fast (claudekei primary agent)' },
  { name: 'claudekei:business-analyst', description: 'BA (claudekei primary agent)' },
  { name: 'claudekei:orchestrator', description: 'Orchestrates (claudekei primary agent)' },
  { name: 'claudekei:explorer', description: 'Explores code' },
  { name: 'claudekei:planner', description: 'Plans (claudekei primary agent)' },
];

describe('derivePrimaryAgents', () => {
  test('marked agents only, default metadata order and colors', () => {
    const p = derivePrimaryAgents(agents);
    expect(p.map((a) => [a.name, a.displayName, a.color])).toEqual([
      ['claudekei:orchestrator', 'Orchestrator', 'purple'],
      ['claudekei:planner', 'Planner', 'blue'],
      ['claudekei:sprinter', 'Sprinter', 'green'],
      ['claudekei:business-analyst', 'Business Analyst', 'orange'],
    ]);
    expect(p[0]!.description).toContain('primary agent');
  });

  test('unknown marked agents are appended with derived names', () => {
    const p = derivePrimaryAgents([...agents, { name: 'acme:code-reviewer', description: 'Reviews (primary agent)' }]);
    expect(p.at(-1)).toMatchObject({ name: 'acme:code-reviewer', displayName: 'Code Reviewer', color: 'gray' });
  });

  test('fallback to the table when nothing is marked', () => {
    const p = derivePrimaryAgents(agents.map((a) => ({ ...a, description: 'plain' })));
    expect(p.map((a) => a.name)).toEqual(['claudekei:orchestrator', 'claudekei:planner', 'claudekei:sprinter', 'claudekei:business-analyst']);
    expect(derivePrimaryAgents([{ name: 'x', description: 'y' }])).toEqual([]);
  });

  test('setting overrides order and decoration; unknown names are ignored', () => {
    const p = derivePrimaryAgents(agents, [{ name: 'claudekei:sprinter', displayName: 'Fast', color: 'red' }, { name: 'claudekei:planner' }, { name: 'ghost' }]);
    expect(p.map((a) => [a.name, a.displayName, a.color])).toEqual([
      ['claudekei:sprinter', 'Fast', 'red'],
      ['claudekei:planner', 'Planner', 'blue'],
    ]);
  });
});

describe('buildCatalog / probe', () => {
  test('defaults follow primary agents; fallback models when none were reported', () => {
    const cat = buildCatalog({ models: [], commands: [], agents, account: null });
    expect(cat.models.map((m) => m.value)).toContain('haiku');
    expect(cat.defaults).toEqual({ model: 'default', mode: 'default', agent: 'claudekei:orchestrator' });
    expect(buildCatalog(probeFromInit(STUB_INIT), { defaultAgent: 'claudekei:planner' }).defaults.agent).toBe('claudekei:planner');
  });

  test('probeCatalog uses a never-yielding prompt, user settings, no persistence; closes the query', async () => {
    let query: FakeQuery | undefined;
    const result = await probeCatalog({
      cwd: '/w',
      env: { PATH: '/x' },
      executablePath: '/bin/claude',
      queryFactory: (params) => (query = new FakeQuery(params, [])),
    });
    expect(result.agents.map((a) => a.name)).toContain('claudekei:planner');
    expect(result.account?.email).toBe('user@example.com');
    expect(query!.closed).toBe(true);
    const o = query!.params.options;
    expect(o).toMatchObject({ cwd: '/w', settingSources: ['user', 'project', 'local'], persistSession: false, pathToClaudeCodeExecutable: '/bin/claude', permissionMode: 'default' });
    // the prompt never yields
    const it = query!.params.prompt[Symbol.asyncIterator]();
    const raced = await Promise.race([it.next().then(() => 'yielded'), new Promise((r) => setTimeout(() => r('pending'), 20))]);
    expect(raced).toBe('pending');
  });

  test('probe timeout rejects', async () => {
    await expect(
      probeCatalog({ cwd: '/w', env: {}, timeoutMs: 20, queryFactory: (params) => Object.assign(new FakeQuery(params, []), { initializationResult: () => new Promise(() => undefined) }) as never }),
    ).rejects.toThrow('timed out');
  });

  test('looksLoggedOut', () => {
    expect(looksLoggedOut(null)).toBe(true);
    expect(looksLoggedOut({})).toBe(true);
    expect(looksLoggedOut({ email: 'a@b.c' })).toBe(false);
    expect(looksLoggedOut({ apiProvider: 'bedrock' })).toBe(false);
    expect(looksLoggedOut({ apiProvider: 'firstParty' })).toBe(true);
    expect(probeFromInit({ account: {} }).account).toBeNull();
  });
});
