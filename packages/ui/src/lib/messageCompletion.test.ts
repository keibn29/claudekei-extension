import { describe, expect, test } from 'bun:test';
import { isMessageComplete, isTurnEndFinish } from './messageCompletion';

describe('isTurnEndFinish', () => {
    test('accepts finish reasons that end a turn', () => {
        for (const finish of ['stop', 'end_turn', 'stop_sequence', 'max_tokens', 'refusal']) {
            expect(isTurnEndFinish(finish)).toBe(true);
        }
    });

    test('rejects intermediate and missing finish reasons', () => {
        for (const finish of ['tool_use', 'pause_turn', '', 'unknown', undefined, null]) {
            expect(isTurnEndFinish(finish)).toBe(false);
        }
    });
});

describe('isMessageComplete', () => {
    const base = { id: 'm1', role: 'assistant', time: { created: 1, completed: 2 } };

    test('treats end_turn as complete and tool_use as incomplete', () => {
        expect(isMessageComplete({ ...base, finish: 'end_turn' })).toBe(true);
        expect(isMessageComplete({ ...base, finish: 'stop' })).toBe(true);
        expect(isMessageComplete({ ...base, finish: 'tool_use' })).toBe(false);
    });
});
