import { describe, expect, test } from 'bun:test';
import {
  COMPOSER_PERMISSION_MODES,
  PERMISSION_MENU_MODES,
  PERMISSION_MODE_DESCRIPTIONS,
  nextPermissionMode,
  resolveComposerMode,
  useDraftPermissionModeStore,
} from './permissionMode';

describe('nextPermissionMode', () => {
  test('cycles default -> acceptEdits -> plan -> default', () => {
    expect(nextPermissionMode('default')).toBe('acceptEdits');
    expect(nextPermissionMode('acceptEdits')).toBe('plan');
    expect(nextPermissionMode('plan')).toBe('default');
  });

  test('restarts the cycle from modes the composer does not offer', () => {
    expect(nextPermissionMode('bypassPermissions')).toBe(COMPOSER_PERMISSION_MODES[0]);
  });
});

describe('resolveComposerMode', () => {
  test('uses the session mode for existing sessions and the draft choice before the first send', () => {
    useDraftPermissionModeStore.getState().setDraftMode(null);
    expect(resolveComposerMode('plan', true)).toBe('plan');
    expect(resolveComposerMode(undefined, true)).toBe('default');
    expect(resolveComposerMode('plan', false)).toBe('default');

    useDraftPermissionModeStore.getState().setDraftMode('acceptEdits');
    expect(resolveComposerMode('plan', false)).toBe('acceptEdits');
    useDraftPermissionModeStore.getState().setDraftMode(null);
  });
});

describe('bypass permissions', () => {
  test('is selectable from the dropdown but never part of the cycle', () => {
    expect(PERMISSION_MENU_MODES).toContain('bypassPermissions');
    expect(COMPOSER_PERMISSION_MODES as readonly string[]).not.toContain('bypassPermissions');
    // cycling from every cycle mode never lands on bypass
    let mode = nextPermissionMode('default');
    for (let i = 0; i < 6; i += 1) {
      expect(mode).not.toBe('bypassPermissions');
      mode = nextPermissionMode(mode);
    }
  });

  test('has the Claude-desktop style description', () => {
    expect(PERMISSION_MODE_DESCRIPTIONS.bypassPermissions).toBe('Run edits and commands without asking');
  });
});
