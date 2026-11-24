import { describe, it, expect } from 'vitest';
import { guiEffectiveArgv, guiPrefsToSave, startupModel } from '../src/guiPrefs.js';
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
