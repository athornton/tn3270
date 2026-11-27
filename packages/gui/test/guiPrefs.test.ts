import { describe, it, expect } from 'vitest';
import { guiEffectiveArgv, guiPrefsToSave, startupAppearance, startupModel } from '../src/guiPrefs.js';
import { connectModels, CONNECT_DEFAULT_MODEL } from '../src/connectDialog.js';

const mem = (files: Record<string, string>) => ({
  readFile: (p: string) => files[p], writeFile: () => {}, rename: () => {}, mkdir: () => {},
});

describe('guiEffectiveArgv', () => {
  it('puts the file first', () => {
    expect(guiEffectiveArgv(['vm'], '/u/preferences.json', mem({ '/u/preferences.json': '{"model":"3278-4-E"}' }), () => {}))
      .toEqual(['-model', '3278-4-E', 'vm']);
  });
  it('a bad value names the file', () => {
    expect(() => guiEffectiveArgv([], '/u/preferences.json', mem({ '/u/preferences.json': '{"codepage":"cp273"}' }), () => {}))
      .toThrow(/^preferences\.json: -codepage: use one of/);
  });
  it('a missing file is nothing', () => {
    expect(guiEffectiveArgv(['vm'], '/u/preferences.json', mem({}), () => {})).toEqual(['vm']);
  });
});

describe('guiPrefsToSave', () => {
  it('the startup settings, then the Model menu\'s choice', () => {
    expect(guiPrefsToSave(['-scheme', 'green', '-model', '3278-2', 'vm'],
      { model: '3278-4-E', oversize: { kind: 'none' } })).toEqual({ scheme: 'green', model: '3278-4-E' });
  });
  it('a non-default oversize from the menu is saved', () => {
    expect(guiPrefsToSave([], { oversize: { kind: 'auto' } })).toEqual({ oversize: 'auto' });
  });
  it('the host and TLS weakenings are never saved', () => {
    expect(guiPrefsToSave(['-insecure', '-devname', 'x===', 'vm'], undefined)).toEqual({});
  });
});

describe('the Connect dialog\'s default model', () => {
  it('is the startup argv\'s model when it is one of the dialog\'s', () => {
    expect(connectModels(startupModel(['-model', '3278-4-E'])).default).toBe('3278-4-E');
  });
  it('else the built-in default', () => {
    expect(connectModels(undefined).default).toBe(CONNECT_DEFAULT_MODEL);
    expect(connectModels('nonsense').default).toBe(CONNECT_DEFAULT_MODEL);
  });
});

describe('guiPrefsToSave with the Options menu settings (B2 Part 2a)', () => {
  const off = { scheme: 'default', highlightBold: false, cursorColor: false };
  it('saves a scheme chosen from the menu, and leaves the built-in default out', () => {
    expect(guiPrefsToSave([], undefined, { ...off, scheme: 'green' })).toEqual({ scheme: 'green' });
    expect(guiPrefsToSave([], undefined, off)).toEqual({});
  });
  it('saves the default when argv had chosen another, so the menu choice wins', () => {
    expect(guiPrefsToSave(['-scheme', 'green'], undefined, off)).toEqual({ scheme: 'default' });
  });
  it('saves the checkboxes when on', () => {
    expect(guiPrefsToSave([], undefined, { ...off, highlightBold: true, cursorColor: true }))
      .toEqual({ highlightbold: true, cursorcolor: true });
  });
  it('drops a flag the menu turned off, so it is not saved back on', () => {
    expect(guiPrefsToSave(['-highlightbold', '-cursorcolor'], undefined, off)).toEqual({});
  });
  it('without the settings, behaves as before', () => {
    expect(guiPrefsToSave(['-highlightbold', '-scheme', 'green'], undefined))
      .toEqual({ highlightbold: true, scheme: 'green' });
  });
});

describe('guiPrefsToSave with the View menu settings (B2 Part 2b)', () => {
  const off = { scheme: 'default', highlightBold: false, cursorColor: false };
  it('saves a chosen scale, and DELETES it when Fit cleared one argv had', () => {
    expect(guiPrefsToSave([], undefined, { ...off, scale: 3 })['scale']).toBe(3);
    expect('scale' in guiPrefsToSave(['-scale', '2'], undefined, { ...off, scale: undefined })).toBe(false);
    expect('scale' in guiPrefsToSave([], undefined, off)).toBe(false);
  });
  it('saves appearance when not system, or when argv had one (the scheme\'s rule)', () => {
    expect(guiPrefsToSave([], undefined, { ...off, appearance: 'dark' })['appearance']).toBe('dark');
    expect('appearance' in guiPrefsToSave([], undefined, { ...off, appearance: 'system' })).toBe(false);
    expect(guiPrefsToSave(['-appearance', 'dark'], undefined, { ...off, appearance: 'system' })['appearance'])
      .toBe('system');
  });
  it('without runtime settings, argv\'s scale and appearance are saved as they were', () => {
    expect(guiPrefsToSave(['-scale', '2', '-appearance', 'light'], undefined))
      .toEqual({ scale: 2, appearance: 'light' });
  });
});

describe('the Connect dialog\'s appearance', () => {
  it('reads -appearance from a hostless argv, and undefined when absent or bad', () => {
    expect(startupAppearance(['-appearance', 'dark'])).toBe('dark');
    expect(startupAppearance([])).toBeUndefined();
    expect(startupAppearance(['-appearance', 'mauve'])).toBeUndefined();
  });
});
