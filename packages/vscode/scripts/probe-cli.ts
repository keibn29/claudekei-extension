#!/usr/bin/env bun
/**
 * Spike S3 (docs/SETTINGS_USAGE_SPEC.md section 8): stdout / stderr / exit code of the installed CLI's config subcommands.
 * Touches ~/.claude: disables and re-enables the claudekei plugin, adds and removes a throwaway MCP server `zz-spike`.
 * Output: src/claude/__fixtures__/config/cli-spike.json
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildEnv, FIXTURES_DIR, SANDBOX_DIR, seedSandbox } from './_common';

const exe = process.argv[2];
if (!exe) throw new Error('usage: bun scripts/probe-cli.ts <path to claude binary>');
seedSandbox();
const results: Array<Record<string, unknown>> = [];
const run = (label: string, args: string[]) => {
  const t = Date.now();
  const r = spawnSync(exe, args, { cwd: SANDBOX_DIR, env: buildEnv() as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 60_000 });
  const entry = { label, args, exit: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t };
  results.push(entry);
  console.log(label, '->', r.status, JSON.stringify(r.stdout).slice(0, 160), JSON.stringify(r.stderr).slice(0, 160));
};
const settings = () => JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')).enabledPlugins;
const json = JSON.stringify({ type: 'stdio', command: 'echo', args: ['spike'], env: { ZZ: '1' } });

run('plugin list --json', ['plugin', 'list', '--json']);
run('plugin disable --json', ['plugin', 'disable', 'claudekei@claudekei', '-s', 'user', '--json']);
results.push({ label: 'enabledPlugins after disable', value: settings() });
run('plugin enable --json', ['plugin', 'enable', 'claudekei@claudekei', '-s', 'user', '--json']);
results.push({ label: 'enabledPlugins after enable', value: settings() });
run('plugin enable (already enabled)', ['plugin', 'enable', 'claudekei@claudekei', '-s', 'user']);
run('plugin enable unknown', ['plugin', 'enable', 'nope@nowhere', '-s', 'user']);
run('mcp add-json', ['mcp', 'add-json', 'zz-spike', json, '-s', 'user']);
run('mcp add-json duplicate', ['mcp', 'add-json', 'zz-spike', json, '-s', 'user']);
run('mcp add-json invalid', ['mcp', 'add-json', 'zz-bad', '{not json', '-s', 'user']);
run('mcp add-json http', ['mcp', 'add-json', 'zz-spike-http', JSON.stringify({ type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { 'X-Test': 'a' } }), '-s', 'local']);
run('mcp remove local', ['mcp', 'remove', 'zz-spike-http', '-s', 'local']);
run('mcp remove', ['mcp', 'remove', 'zz-spike', '-s', 'user']);
run('mcp remove missing', ['mcp', 'remove', 'zz-spike', '-s', 'user']);
writeFileSync(join(FIXTURES_DIR, 'config', 'cli-spike.json'), JSON.stringify(results, null, 2).replace(new RegExp(homedir(), 'g'), '~') + '\n');
