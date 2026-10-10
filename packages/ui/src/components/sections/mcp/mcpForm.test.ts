import { describe, expect, test } from 'bun:test';
import { configFromForm, emptyMcpForm, formFromConfig, isMcpFormDirty, validateMcpForm } from './mcpForm';

describe('mcpForm', () => {
  test('round-trips stdio and http configs through the text form', () => {
    const stdio = { type: 'stdio' as const, command: 'npx', args: ['-y', 'pkg'], env: { A: '1', B: 'x=y' } };
    expect(configFromForm(formFromConfig(stdio))).toEqual(stdio);
    const http = { type: 'http' as const, url: 'https://example.com/mcp', headers: { Authorization: 'Bearer a:b' } };
    expect(configFromForm(formFromConfig(http))).toEqual(http);
  });

  test('omits empty args, env and headers', () => {
    expect(configFromForm({ ...emptyMcpForm(), command: ' uvx ' })).toEqual({ type: 'stdio', command: 'uvx' });
    expect(configFromForm({ ...emptyMcpForm(), type: 'sse', url: 'http://localhost:1/sse' })).toEqual({ type: 'sse', url: 'http://localhost:1/sse' });
  });

  test('validates per transport and reports the offending line', () => {
    expect(validateMcpForm(emptyMcpForm(), 'bad name')).toEqual({ name: 'invalid', command: 'required' });
    expect(validateMcpForm({ ...emptyMcpForm(), command: 'x', env: 'A=1\nnope' }, 'ok')).toEqual({ env: 2 });
    expect(validateMcpForm({ ...emptyMcpForm(), type: 'http', url: 'ftp://x', headers: 'no colon' }, null)).toEqual({ url: 'invalid', headers: 1 });
  });

  test('dirty ignores whitespace-only edits', () => {
    const baseline = formFromConfig({ type: 'stdio', command: 'npx', args: ['a'] });
    expect(isMcpFormDirty({ ...baseline, args: 'a\n\n' }, baseline)).toBe(false);
    expect(isMcpFormDirty({ ...baseline, args: 'b' }, baseline)).toBe(true);
  });
});
