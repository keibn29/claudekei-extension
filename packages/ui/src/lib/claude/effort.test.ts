import { describe, expect, test } from 'bun:test';
import { resolveComposerEffort } from './effort';

describe('resolveComposerEffort', () => {
  test('a session shows the host effort; unset means model default', () => {
    expect(resolveComposerEffort({ hasSession: true, sessionEffort: 'high', draftEffort: 'low' })).toBe('high');
    expect(resolveComposerEffort({ hasSession: true, draftEffort: 'low', agentDefaultEffort: 'max' })).toBeNull();
  });

  test('a draft keeps its explicit choice, including "model default"', () => {
    expect(resolveComposerEffort({ hasSession: false, draftEffort: 'low', agentDefaultEffort: 'max' })).toBe('low');
    expect(resolveComposerEffort({ hasSession: false, draftEffort: null, agentDefaultEffort: 'max' })).toBeNull();
  });

  test('an untouched draft follows the agent default, then the catalog default', () => {
    expect(resolveComposerEffort({ hasSession: false, draftEffort: undefined, agentDefaultEffort: 'xhigh', catalogDefaultEffort: 'medium' })).toBe('xhigh');
    expect(resolveComposerEffort({ hasSession: false, draftEffort: undefined, catalogDefaultEffort: 'medium' })).toBe('medium');
    expect(resolveComposerEffort({ hasSession: false, draftEffort: undefined })).toBeNull();
  });
});
