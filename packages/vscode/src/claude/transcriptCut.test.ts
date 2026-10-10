import { describe, expect, test } from 'bun:test';
import { cutUuidBefore, forkUuidOf } from './transcriptCut';

const user = (id: string, claudeUuid?: string) => ({ id, role: 'user', claudeUuid });
const assistant = (id: string, claudeUuid?: string) => ({ id, role: 'assistant', claudeUuid });

describe('transcript cuts', () => {
  test('a user message cuts at its own uuid, an assistant message at its last entry', () => {
    expect(forkUuidOf(user('m1', 'u1'), [])).toBe('u1');
    expect(forkUuidOf(assistant('m2', 'a1'), [{ type: 'text' }])).toBe('a1');
  });

  test('an assistant message ending with a tool call needs the result uuid', () => {
    expect(forkUuidOf(assistant('m2', 'a1'), [{ type: 'tool', metadata: { resultUuid: 'r1' } }])).toBe('r1');
    expect(forkUuidOf(assistant('m2', 'a1'), [{ type: 'tool', state: { status: 'running' } }])).toBeUndefined();
  });

  test('cutUuidBefore walks back to the last cuttable message and is undefined for the first', () => {
    const messages = [user('m1', 'u1'), assistant('m2', 'a1'), assistant('m3', 'a2'), user('m4', 'u2')];
    const parts = { m3: [{ type: 'tool' }] }; // no result uuid yet: not a cut point
    expect(cutUuidBefore(messages, parts, 3)).toBe('a1');
    expect(cutUuidBefore(messages, parts, 1)).toBe('u1');
    expect(cutUuidBefore(messages, parts, 0)).toBeUndefined();
  });
});
