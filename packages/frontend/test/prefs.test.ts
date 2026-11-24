import { describe, it, expect } from 'vitest';
import {
  GUI_PREF_KEYS, TUI_PREF_KEYS, prefsToArgv, argvToPrefs, parsePrefsJson, oversizeFlagValue,
  loadPrefs, savePrefs, type PrefsFs,
} from '../src/prefs.js';

describe('prefsToArgv', () => {
  it('maps each type to its flag form', () => {
    const r = prefsToArgv({ model: '3278-4-E', visualbell: true, ddm: false, colors: 256, cafile: '/ca.pem' }, TUI_PREF_KEYS);
    expect(r.argv).toEqual(['-model', '3278-4-E', '-visualbell', '-ddm', 'off', '--colors', '256', '-cafile', '/ca.pem']);
    expect(r.warnings).toEqual([]);
  });
  it('visualbell false emits nothing', () => {
    expect(prefsToArgv({ visualbell: false }, GUI_PREF_KEYS).argv).toEqual([]);
  });
  it('an unknown key is a warning and skipped', () => {
    const r = prefsToArgv({ colour: 'red', model: '3278-2' }, GUI_PREF_KEYS);
    expect(r.argv).toEqual(['-model', '3278-2']);
    expect(r.warnings).toEqual(['ignoring unknown key "colour"']);
  });
  it('a refused key is a warning saying why, and skipped', () => {
    const r = prefsToArgv({ insecure: true, host: 'vm' }, GUI_PREF_KEYS);
    expect(r.argv).toEqual([]);
    expect(r.warnings[0]).toMatch(/^ignoring "insecure": .*TLS/);
    expect(r.warnings[1]).toMatch(/^ignoring "host": /);
  });
  it('colors is TUI only', () => {
    expect(prefsToArgv({ colors: 16 }, GUI_PREF_KEYS).warnings).toEqual(['ignoring unknown key "colors"']);
  });
  it('a value of the wrong type throws, naming the key', () => {
    expect(() => prefsToArgv({ model: 4 }, GUI_PREF_KEYS)).toThrow('"model" must be a string');
    expect(() => prefsToArgv({ ddm: 'off' }, GUI_PREF_KEYS)).toThrow('"ddm" must be true or false');
  });
});

describe('parsePrefsJson', () => {
  it('accepts an object, refuses anything else', () => {
    expect(parsePrefsJson('{"model":"3278-2"}')).toEqual({ model: '3278-2' });
    expect(() => parsePrefsJson('[1]')).toThrow('must be a JSON object');
    expect(() => parsePrefsJson('{nope')).toThrow(/not valid JSON/);
  });
});

describe('argvToPrefs, the inverse', () => {
  it('collects stored flags, last one winning, and skips everything else', () => {
    const p = argvToPrefs(['-model', '3278-2', '-insecure', '-model', '3278-4-E', '-ddm', 'off',
      '-visualbell', '-scheme', 'green', 'vm.example:3270', '-devname', 'x==='], GUI_PREF_KEYS);
    expect(p).toEqual({ model: '3278-4-E', ddm: false, visualbell: true, scheme: 'green' });
  });
  it('reads an alias as its key', () => {
    expect(argvToPrefs(['-charset', 'cp037'], GUI_PREF_KEYS)).toEqual({ codepage: 'cp037' });
  });
  it('round-trips with prefsToArgv', () => {
    const prefs = { model: '3278-4-E', oversize: 'auto', codepage: 'cp037', tn3270e: true, cafile: '/c' };
    expect(argvToPrefs(prefsToArgv(prefs, GUI_PREF_KEYS).argv, GUI_PREF_KEYS)).toEqual(prefs);
  });
});

describe('oversizeFlagValue', () => {
  it.each([[{ kind: 'none' }, 'none'], [{ kind: 'auto' }, 'auto'], [{ kind: 'fixed', rows: 62, cols: 160 }, '160x62']] as const)(
    '%o is %s', (o, s) => { expect(oversizeFlagValue(o)).toBe(s); });
});

function memFs(files: Record<string, string> = {}): PrefsFs & { files: Record<string, string>; ops: string[] } {
  const ops: string[] = [];
  return {
    files, ops,
    readFile: (p) => files[p],
    writeFile: (p, t) => { ops.push(`write ${p}`); files[p] = t; },
    rename: (a, b) => { ops.push(`rename ${a} ${b}`); files[b] = files[a]!; delete files[a]; },
    mkdir: (p) => { ops.push(`mkdir ${p}`); },
  };
}

describe('loadPrefs and savePrefs', () => {
  it('a missing file is no preferences', () => {
    expect(loadPrefs('/c/tui.json', TUI_PREF_KEYS, memFs())).toEqual({ argv: [], warnings: [] });
  });
  it('errors and warnings name the file', () => {
    expect(() => loadPrefs('/c/tui.json', TUI_PREF_KEYS, memFs({ '/c/tui.json': '{x' }))).toThrow(/^tui\.json: not valid JSON/);
    expect(loadPrefs('/c/tui.json', TUI_PREF_KEYS, memFs({ '/c/tui.json': '{"zz":1}' })).warnings)
      .toEqual(['tui.json: ignoring unknown key "zz"']);
  });
  it('saves atomically, creating the directory', () => {
    const fs = memFs();
    expect(savePrefs('/c/d/p.json', { model: '3278-2' }, GUI_PREF_KEYS, fs)).toBe(1);
    expect(fs.ops).toEqual(['mkdir /c/d', 'write /c/d/p.json.tmp', 'rename /c/d/p.json.tmp /c/d/p.json']);
    expect(JSON.parse(fs.files['/c/d/p.json']!)).toEqual({ model: '3278-2' });
  });
  it('keeps keys this version does not store, and replaces the ones it does', () => {
    const fs = memFs({ '/p.json': '{"future":42,"model":"3278-2","scheme":"green"}' });
    savePrefs('/p.json', { model: '3278-4-E' }, GUI_PREF_KEYS, fs);
    expect(JSON.parse(fs.files['/p.json']!)).toEqual({ future: 42, model: '3278-4-E' });
  });
});
