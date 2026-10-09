import { describe, expect, test } from 'bun:test';
import { isPermissionModeValue } from './permissionMode';
import { collectSendFiles, composePromptText } from './send';

describe('composePromptText', () => {
  test('folds preface, text and additional context parts into one prompt', () => {
    const text = composePromptText({
      prefaceText: 'Context first',
      text: 'Explain @src/a.ts',
      additionalParts: [
        { text: 'Selected range from src/a.ts (#L1-#L2)\n\n```ts\nconst a = 1\n```', synthetic: true },
        { text: '   ' },
      ],
    });
    expect(text).toBe('Context first\n\nExplain @src/a.ts\n\nSelected range from src/a.ts (#L1-#L2)\n\n```ts\nconst a = 1\n```');
  });

  test('returns an empty string when there is nothing to send', () => {
    expect(composePromptText({ text: '  ' })).toBe('');
  });
});

describe('collectSendFiles', () => {
  test('keeps inline data URLs and drops server-side file mentions', async () => {
    const files = await collectSendFiles({
      text: 'hi',
      files: [
        { mime: 'image/png', filename: 'a.png', url: 'data:image/png;base64,AAAA' },
        { mime: 'text/plain', filename: 'b.ts', url: 'file:///work/b.ts' },
      ],
      additionalParts: [{ text: 'ctx', files: [{ mime: 'text/plain', url: 'data:text/plain;base64,QQ==' }] }],
    });
    expect(files).toEqual([
      { mime: 'image/png', filename: 'a.png', dataUrl: 'data:image/png;base64,AAAA' },
      { mime: 'text/plain', filename: 'attachment', dataUrl: 'data:text/plain;base64,QQ==' },
    ]);
  });
});

describe('isPermissionModeValue', () => {
  test('accepts permission modes and rejects other agent names', () => {
    expect(isPermissionModeValue('plan')).toBe(true);
    expect(isPermissionModeValue('acceptEdits')).toBe(true);
    expect(isPermissionModeValue('Explore')).toBe(false);
    expect(isPermissionModeValue(undefined)).toBe(false);
  });
});
