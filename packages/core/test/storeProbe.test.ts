import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  BUNDLE_ID, CheckFailed, IDENTITY_NAME, PUBLISHER, TEAM_ID, containerPath, judgeMacConfinement, judgeSignatureVerify, judgeWinConfinement,
  launchForProbe, macRoute, main, newestSdkTool, parseAppxPackage, parseProbeLine, removeContainer, winRoute,
} from '../../../scripts/store-probe.mjs';
import {
  ALIAS, CONTAINER, HOME, INSTALL, LOGIN_HELPER, MAC_APP, MAC_DIR, MAC_FIND, MAC_SRC, MAC_WORK, PW, SANDBOXED_LINE, SDK, SIGNTOOL,
  THUMB, WIN_DIR, WIN_LINE, WIN_WORK, fakeChecks, fx, macWorld, ok, psKind, psScript, ran, winWorld,
} from './helpers/storeProbeWorld.js';

const ENTITLEMENTS = () => fx('codesign-d-entitlements-mas.txt');
/** Round 4's variant D golden launch (run 43115293433): the probe line of a sandboxed copy. */
const SANDBOXED = () => parseProbeLine(fx('probe-mac-sandboxed.txt'));
/** Round 2's variant B (run 43112504521), which ran unsandboxed. */
const UNSANDBOXED = () => parseProbeLine(fx('probe-mac-unsandboxed.txt'));
const PKG = () => parseAppxPackage(fx('get-appxpackage.json'));
const STARTED = () => fx('package-full-name.txt').trim();

describe('the placeholder identity matches electron-builder.cjs', () => {
  it('appId, appx identityName and publisher; the team in the main entitlements', () => {
    const gui = fileURLToPath(new URL('../../gui/', import.meta.url));
    const cfg = createRequire(import.meta.url)(`${gui}electron-builder.cjs`) as { appId: string; appx: { identityName: string; publisher: string } };
    expect(BUNDLE_ID).toBe(cfg.appId);
    expect(IDENTITY_NAME).toBe(cfg.appx.identityName);
    expect(PUBLISHER).toBe(cfg.appx.publisher);
    expect(readFileSync(`${gui}resources/entitlements.mas.plist`, 'utf8')).toContain(`<string>${TEAM_ID}.${BUNDLE_ID}</string>`);
  });
});

describe('parseProbeLine (CI captures)', () => {
  it('reads the sandboxed mac copy (run 43115293433), the unsandboxed one (43112504521) and the MSIX alias launch', () => {
    expect(SANDBOXED()).toEqual({ sandbox: BUNDLE_ID, windowsStore: false });
    expect(UNSANDBOXED()).toEqual({ sandbox: null, windowsStore: false });
    expect(parseProbeLine(fx('probe-win-alias.txt'))).toEqual({ sandbox: null, windowsStore: true });
  });
  it('takes the LAST probe: line', () => {
    expect(parseProbeLine('probe: sandbox=none windowsStore=false\nx\nprobe: sandbox=a.b windowsStore=true\n')).toEqual({ sandbox: 'a.b', windowsStore: true });
  });
  it('FAIL-CLOSED: no probe line, or a malformed one, is null (never "unconfined")', () => {
    expect(parseProbeLine('')).toBeNull();
    expect(parseProbeLine(null)).toBeNull();
    expect(parseProbeLine('shot: /x.png 720x350\n')).toBeNull();
    for (const bad of [
      'probe: sandbox= windowsStore=true', 'probe: sandbox=x windowsStore=yes', 'probe: sandbox=x', 'probe: windowsStore=true sandbox=x',
      'probe: sandbox=x windowsStore=true extra', 'probe:sandbox=x windowsStore=true',
    ]) expect(parseProbeLine(`${bad}\n`), bad).toBeNull();
    // A malformed LAST line is not rescued by an earlier good one.
    expect(parseProbeLine(`probe: sandbox=${BUNDLE_ID} windowsStore=false\nprobe: sandbox=${BUNDLE_ID}\n`)).toBeNull();
  });
});

describe('judgeMacConfinement (round 4 captures, then each requirement removed)', () => {
  const good = () => ({ entitlements: ENTITLEMENTS(), containerExists: true, probe: SANDBOXED() });
  it('passes the captured variant-D copy', () => {
    expect(judgeMacConfinement(good(), BUNDLE_ID)).toEqual([]);
  });
  it('fails without app-sandbox true in the signature', () => {
    expect(judgeMacConfinement({ ...good(), entitlements: ENTITLEMENTS().replace('<key>com.apple.security.app-sandbox</key><true/>', '') }, BUNDLE_ID).join('\n')).toMatch(/app-sandbox/);
    expect(judgeMacConfinement({ ...good(), entitlements: ENTITLEMENTS().replace('<key>com.apple.security.app-sandbox</key><true/>', '<key>com.apple.security.app-sandbox</key><false/>') }, BUNDLE_ID).join('\n')).toMatch(/app-sandbox/);
    expect(judgeMacConfinement({ ...good(), entitlements: '' }, BUNDLE_ID).join('\n')).toMatch(/app-sandbox/);
  });
  it('fails when the container did not appear', () => {
    expect(judgeMacConfinement({ ...good(), containerExists: false }, BUNDLE_ID).join('\n')).toMatch(/no container ~\/Library\/Containers\/io\.github\.athornton\.tn3270/);
  });
  it('FAIL-CLOSED: sandbox=none (the captured unsandboxed copy) fails', () => {
    expect(judgeMacConfinement({ ...good(), probe: UNSANDBOXED() }, BUNDLE_ID).join('\n')).toMatch(/sandbox=none/);
  });
  it('FAIL-CLOSED: a missing or malformed probe line fails', () => {
    expect(judgeMacConfinement({ ...good(), probe: null }, BUNDLE_ID).join('\n')).toMatch(/confinement is unproven/);
    expect(judgeMacConfinement({ ...good(), probe: parseProbeLine('probe: garbage') }, BUNDLE_ID).join('\n')).toMatch(/confinement is unproven/);
  });
  it('fails a different container id', () => {
    expect(judgeMacConfinement({ ...good(), probe: { sandbox: 'com.example.other', windowsStore: false } }, BUNDLE_ID).join('\n')).toMatch(/sandbox=com\.example\.other, not io\.github/);
  });
  it('names every missing requirement at once', () => {
    expect(judgeMacConfinement({ entitlements: '', containerExists: false, probe: null }, BUNDLE_ID)).toHaveLength(3);
  });
});

describe('judgeSignatureVerify (round 3 and 4 captures)', () => {
  it('passes the captured variant-D --verify (round 4, exit 0)', () => {
    expect(judgeSignatureVerify(fx('codesign-verify-mas-valid.txt'), 0)).toEqual([]);
  });
  it('fails the captured round-3 --verify (exit 1, "not signed at all")', () => {
    const p = judgeSignatureVerify(fx('codesign-verify-mas-notsigned.txt'), 1).join('\n');
    expect(p).toMatch(/exited 1/);
    expect(p).toMatch(/code object is not signed at all/);
  });
  it('FAIL-CLOSED: a --verify naming a subcomponent fails even at exit 0 (composite: round 4 valid + round 3 codesign lines)', () => {
    const text = `${fx('codesign-verify-mas-valid.txt')}\n${fx('codesign-sign-subcomponent.txt')}`;
    expect(judgeSignatureVerify(text, 0).join('\n')).toMatch(/In subcomponent: .*TN3270 Login Helper\.app/);
  });
  it('FAIL-CLOSED: exit 0 without "valid on disk" fails; so does a non-zero exit with it', () => {
    expect(judgeSignatureVerify('', 0).join('\n')).toMatch(/valid on disk/);
    expect(judgeSignatureVerify(fx('codesign-verify-mas-valid.txt'), 3).join('\n')).toMatch(/exited 3/);
  });
});

describe('parseAppxPackage (round 2 capture)', () => {
  it('reads the captured Get-AppxPackage JSON (run 43112504521)', () => {
    expect(PKG()).toEqual({
      name: 'TN3270.Probe', packageFamilyName: 'TN3270.Probe_5j71tdef09jdy',
      packageFullName: 'TN3270.Probe_0.1.4.0_x64__5j71tdef09jdy',
      installLocation: 'C:\\Program Files\\WindowsApps\\TN3270.Probe_0.1.4.0_x64__5j71tdef09jdy',
    });
  });
  it('is null for no output, non-JSON, an array (two packages) or a missing field', () => {
    expect(parseAppxPackage('')).toBeNull();
    expect(parseAppxPackage('Get-AppxPackage : not recognized')).toBeNull();
    expect(parseAppxPackage(`[${fx('get-appxpackage.json').trim()},${fx('get-appxpackage.json').trim()}]`)).toBeNull();
    expect(parseAppxPackage('null')).toBeNull();
    for (const k of ['Name', 'PackageFamilyName', 'PackageFullName', 'InstallLocation']) {
      const o = JSON.parse(fx('get-appxpackage.json')) as Record<string, unknown>;
      delete o[k];
      expect(parseAppxPackage(JSON.stringify(o)), k).toBeNull();
    }
  });
});

describe('judgeWinConfinement (round 2 captures, then each requirement removed)', () => {
  const good = () => ({ pkg: PKG(), probe: parseProbeLine(fx('probe-win-alias.txt')), started: STARTED() });
  it('passes the captured alias launch', () => {
    expect(judgeWinConfinement(good(), IDENTITY_NAME)).toEqual([]);
  });
  it('fails when Get-AppxPackage lists nothing, or another name', () => {
    expect(judgeWinConfinement({ ...good(), pkg: null }, IDENTITY_NAME).join('\n')).toMatch(/lists no TN3270\.Probe/);
    expect(judgeWinConfinement({ ...good(), pkg: { ...PKG()!, name: 'Other' } }, IDENTITY_NAME).join('\n')).toMatch(/lists Other, not TN3270\.Probe/);
  });
  it('FAIL-CLOSED: windowsStore=false fails', () => {
    expect(judgeWinConfinement({ ...good(), probe: { sandbox: null, windowsStore: false } }, IDENTITY_NAME).join('\n')).toMatch(/windowsStore=false/);
  });
  it('FAIL-CLOSED: a missing or malformed probe line fails', () => {
    expect(judgeWinConfinement({ ...good(), probe: null }, IDENTITY_NAME).join('\n')).toMatch(/confinement is unproven/);
    expect(judgeWinConfinement({ ...good(), probe: parseProbeLine('probe: sandbox=none windowsStore=TRUE') }, IDENTITY_NAME).join('\n')).toMatch(/confinement is unproven/);
  });
  it('fails when the started process has another package, none, or was not measured', () => {
    expect(judgeWinConfinement({ ...good(), started: 'none (APPMODEL_ERROR_NO_PACKAGE)' }, IDENTITY_NAME).join('\n')).toMatch(/package is none \(APPMODEL_ERROR_NO_PACKAGE\), not TN3270\.Probe_0\.1\.4\.0_x64__5j71tdef09jdy/);
    expect(judgeWinConfinement({ ...good(), started: null }, IDENTITY_NAME).join('\n')).toMatch(/not measured/);
    expect(judgeWinConfinement({ ...good(), started: '' }, IDENTITY_NAME).join('\n')).toMatch(/not measured/);
  });
});

describe('routes: target-platform paths on any host (verify-signatures lesson, CI run 42844605289)', () => {
  const fakeIo = () => {
    const made: string[] = [];
    const copied: [string, string][] = [];
    return {
      made, copied,
      io: { home: '/Users/runner', trace: '/repo/synthetic-ispf-like.trace', fs: { mkdir: (d: string) => { made.push(d); }, copy: (a: string, b: string) => { copied.push([a, b]); } } },
    };
  };
  it('macRoute: the copy\'s executable, and every staged path under the container\'s Data/probe-<n>/, with /', () => {
    const { io, made, copied } = fakeIo();
    const r = macRoute(io, '/scratch/TN3270.app');
    expect(r).toMatchObject({ exe: '/scratch/TN3270.app/Contents/MacOS/TN3270', prefix: [], env: {}, probe: true });
    const data = '/Users/runner/Library/Containers/io.github.athornton.tn3270/Data';
    expect(r.stage!('C:\\host\\launch-1')).toEqual({
      trace: `${data}/probe-1/synthetic-ispf-like.trace`, shot: `${data}/probe-1/shot.png`, userData: `${data}/probe-1/user-data`,
    });
    expect(r.stage!('/host/launch-2').shot).toBe(`${data}/probe-2/shot.png`);
    expect(made).toEqual([`${data}/probe-1`, `${data}/probe-2`]);
    expect(copied[0]).toEqual(['/repo/synthetic-ispf-like.trace', `${data}/probe-1/synthetic-ispf-like.trace`]);
    expect(containerPath('/Users/runner')).toBe('/Users/runner/Library/Containers/io.github.athornton.tn3270');
  });
  it('winRoute: the alias, the install location as processDir, and the stage in the launch dir, with \\', () => {
    const inst = 'C:\\Program Files\\WindowsApps\\TN3270.Probe_0.1.4.0_x64__5j71tdef09jdy';
    const alias = 'C:\\Users\\runneradmin\\AppData\\Local\\Microsoft\\WindowsApps\\tn3270-gui.exe';
    const r = winRoute({ trace: 'C:\\repo\\t.trace' }, { alias, installLocation: inst });
    expect(r).toMatchObject({ exe: alias, prefix: [], env: {}, probe: true, installDir: inst, processDir: inst });
    expect(r.stage!('C:\\scratch\\shot-1')).toEqual({ trace: 'C:\\repo\\t.trace', shot: 'C:\\scratch\\shot-1\\shot.png', userData: 'C:\\scratch\\shot-1\\user-data' });
  });
});

// ---------------------------------------------------------------------------------------------
// Task 5: the drivers and main, against fake worlds (helpers/storeProbeWorld.ts).

const at = (events: string[], e: string) => {
  const i = events.indexOf(e);
  expect(i, `${e} in ${events.join(' | ')}`).toBeGreaterThanOrEqual(0);
  return i;
};
const fails = (out: string[]) => out.filter((l) => l.startsWith('FAIL '));

describe('main: arguments and platforms', () => {
  it('linux: exit 2, "nothing to probe on linux"', async () => {
    const w = macWorld({ io: { platform: 'linux' } });
    expect(await main([], w.io)).toBe(2);
    expect(w.out.join('\n')).toMatch(/nothing to probe on linux/);
    expect(w.calls).toEqual([]);
  });
  it('an option or two directories: exit 2', async () => {
    expect(await main(['--expect', 'x'], macWorld().io)).toBe(2);
    expect(await main(['/a', '/b'], macWorld().io)).toBe(2);
  });
  it('macOS without mas-universal/TN3270.app: exit 2, saying how to build it, and nothing run', async () => {
    const w = macWorld();
    expect(await main(['/elsewhere'], w.io)).toBe(2);
    expect(w.out.join('\n')).toMatch(/no \/elsewhere\/mas-universal\/TN3270\.app: build .*--mac mas --universal -c\.mac\.identity=null/);
    expect(w.calls).toEqual([]);
  });
  it('Windows needs exactly one TN3270-*-win-x64.appx: none or two is exit 2', async () => {
    for (const files of [['TN3270-0.1.4-win-x64.exe'], ['TN3270-0.1.4-win-x64.appx', 'TN3270-0.1.5-win-x64.appx']]) {
      const w = winWorld({ files });
      expect(await main([WIN_DIR], w.io)).toBe(2);
      expect(w.out.join('\n')).toMatch(/expected exactly one TN3270-\*-win-x64\.appx/);
      expect(w.calls).toEqual([]);
    }
  });
});

describe('main on macOS (a port of mac-sandbox.sh variant D)', () => {
  it('happy path: the spike\'s commands in its order, confined, both checks ok, cleanup, exit 0', async () => {
    const w = macWorld();
    expect(await main([MAC_DIR], w.io)).toBe(0);
    const res = (n: string) => expect.stringMatching(new RegExp(`/packages/gui/resources/${n.replace(/\./g, '\\.')}$`));
    expect(w.calls.slice(0, 3)).toEqual([['plutil', '-lint', res('entitlements.mas.plist')], ['plutil', '-lint', res('entitlements.mas.inherit.plist')], ['plutil', '-lint', res('entitlements.mas.loginhelper.plist')]]);
    const signing = w.calls.slice(3).filter((c) => c[0] !== 'find');
    const plist = `${MAC_APP}/Contents/Info.plist`;
    const inherit = signing.find((c) => c.includes(MAC_FIND.helpers[0]!))!.at(-2)!;
    const login = signing.find((c) => c.includes(LOGIN_HELPER))!.at(-2)!;
    const mainEnt = signing.find((c) => c.at(-1) === MAC_APP && c[1] === '--force')!.at(-2)!;
    expect([inherit, login, mainEnt]).toEqual([res('entitlements.mas.inherit.plist'), res('entitlements.mas.loginhelper.plist'), res('entitlements.mas.plist')]);
    expect(signing).toEqual([
      ['ditto', MAC_SRC, MAC_APP],
      ['/usr/libexec/PlistBuddy', '-c', 'Add :ElectronTeamID string H68TN685J4', plist],
      ['/usr/libexec/PlistBuddy', '-c', 'Print :ElectronTeamID', plist],
      ...MAC_FIND.dylibs.map((f) => ['codesign', '--force', '-s', '-', f]),
      ...MAC_FIND.frameworks.map((f) => ['codesign', '--force', '--deep', '-s', '-', f]),
      ...MAC_FIND.helpers.map((f) => ['codesign', '--force', '-s', '-', '--entitlements', inherit, f]),
      ...MAC_FIND.login.map((f) => ['codesign', '--force', '-s', '-', '--entitlements', login, f]),
      ['codesign', '--force', '-s', '-', '--entitlements', login, LOGIN_HELPER],
      ['codesign', '--force', '-s', '-', '--entitlements', mainEnt, MAC_APP],
      ['codesign', '-d', '--entitlements', ':-', MAC_APP],
      ['codesign', '--verify', '--deep', '--strict', '--verbose=2', MAC_APP],
      ['ps', '-ww', '-axo', 'pid=,comm='],
      ['kill', '-9', '101', '103'],
    ]);
    expect(w.calls.filter((c) => c[0] === 'find')).toEqual([
      ['find', `${MAC_APP}/Contents/Frameworks`, '-name', '*.dylib'],
      ['find', `${MAC_APP}/Contents/Frameworks`, '-maxdepth', '1', '-name', '*.framework'],
      ['find', `${MAC_APP}/Contents/Frameworks`, '-maxdepth', '1', '-name', '*.app'],
      ['find', `${LOGIN_HELPER}/Contents/MacOS`, '-type', 'f', '-perm', '-u+x'],
    ]);
    // A stale container is removed BEFORE the copy; launch after --verify; checks after the launch; cleanup last.
    const e = w.events;
    expect(at(e, `rm ${CONTAINER}`)).toBeLessThan(at(e, 'run ditto'));
    expect(at(e, 'run codesign --verify')).toBeLessThan(at(e, 'launch'));
    expect(at(e, 'launch')).toBeLessThan(at(e, `check drawsGolden ${MAC_WORK}`));
    expect(at(e, `check drawsGolden ${MAC_WORK}`)).toBeLessThan(at(e, `check dialogConnects ${MAC_WORK}`));
    expect(at(e, `check dialogConnects ${MAC_WORK}`)).toBeLessThan(at(e, 'run ps'));
    expect(e.slice(-2)).toEqual([`rm ${CONTAINER}`, `rm ${MAC_WORK}`]);
    // The confinement launch is the spike's `bare` one, on the copy's executable.
    expect(w.launchArgs).toEqual([['--disable-gpu']]);
    expect(w.routes[0]).toMatchObject({ exe: `${MAC_APP}/Contents/MacOS/TN3270`, probe: true });
    expect(fails(w.out)).toEqual([]);
    expect(w.out.filter((l) => l.startsWith('ok '))).toEqual([
      'ok mac-sandbox: signed (ad-hoc, app-sandbox entitled, codesign --verify --deep --strict clean)',
      `ok mac-sandbox: confined (the app reports sandbox=io.github.athornton.tn3270; ${CONTAINER} exists)`,
      'ok mac-sandbox: replays a trace and draws the synthetic-ispf golden',
      'ok mac-sandbox: with no host, opens the Connect dialog and connects',
    ]);
    for (const p of ['copy', 'sign', 'verify', 'confine', 'check drawsGolden', 'check dialogConnects', 'cleanup', 'total']) {
      expect(w.out.some((l) => new RegExp(`^time ${p}: \\d+\\.\\ds$`).test(l)), p).toBe(true);
    }
  });
  it('ElectronTeamID: Set when Add fails (the key exists), as the spike does', async () => {
    const w = macWorld({ answers: { 'PlistBuddy Add': ran(1, 'Add: ":ElectronTeamID" Entry Already Exists') } });
    expect(await main([MAC_DIR], w.io)).toBe(0);
    expect(w.calls.filter((c) => c[0] === '/usr/libexec/PlistBuddy').map((c) => c[2])).toEqual(['Add :ElectronTeamID string H68TN685J4', 'Set :ElectronTeamID H68TN685J4', 'Print :ElectronTeamID']);
  });
  it('the container missing after the launch: exit 1, naming it, and the checks not run', async () => {
    const w = macWorld({ makesContainer: false });
    expect(await main([MAC_DIR], w.io)).toBe(1);
    expect(fails(w.out)).toEqual([`FAIL mac-sandbox: no container ~/Library/Containers/io.github.athornton.tn3270 after the launch: the sandbox did not take`]);
    expect(w.events.some((e) => e.startsWith('check '))).toBe(false);
  });
  it('FAIL-CLOSED: sandbox=none from the confinement launch (the captured unsandboxed copy) is exit 1, checks not run', async () => {
    const w = macWorld({ launched: { stdout: fx('probe-mac-unsandboxed.txt') } });
    expect(await main([MAC_DIR], w.io)).toBe(1);
    expect(fails(w.out).join('\n')).toMatch(/sandbox=none: it is NOT sandboxed/);
    expect(w.events.some((e) => e.startsWith('check '))).toBe(false);
  });
  it('FAIL-CLOSED: no probe line from the confinement launch is exit 1, not "unconfined OK"', async () => {
    const w = macWorld({ launched: { stdout: 'connect: dialog shown\n' } });
    expect(await main([MAC_DIR], w.io)).toBe(1);
    expect(fails(w.out).join('\n')).toMatch(/confinement is unproven/);
  });
  it('FAIL-CLOSED: a check whose launch printed no probe line, or a malformed or sandbox=none one, FAILs', async () => {
    for (const [line, why] of [[null, /confinement is unproven/], ['probe: sandbox=io.github.athornton.tn3270', /confinement is unproven/], ['probe: sandbox=none windowsStore=false', /sandbox=none/]] as const) {
      const events: string[] = [];
      const w = macWorld({ io: { checks: fakeChecks(events, (i) => (i === 1 ? line : SANDBOXED_LINE)) } });
      expect(await main([MAC_DIR], w.io), String(line)).toBe(1);
      expect(fails(w.out)).toHaveLength(1);
      expect(fails(w.out)[0]).toMatch(/^FAIL mac-sandbox: with no host, opens the Connect dialog and connects: /);
      expect(fails(w.out)[0]).toMatch(why);
    }
  });
  it('a check that throws CheckFailed is its FAIL; the next check still runs', async () => {
    const checks = [
      ['first', async () => { throw new CheckFailed('expected exit 0 and a shot line'); }],
      ['second', async () => ({ note: '', probe: SANDBOXED_LINE })],
    ] as const;
    const w = macWorld({ io: { checks } });
    expect(await main([MAC_DIR], w.io)).toBe(1);
    expect(fails(w.out)).toEqual(['FAIL mac-sandbox: first: expected exit 0 and a shot line']);
    expect(w.out).toContain('ok mac-sandbox: second');
  });
  it('FAIL-CLOSED: a --verify naming a subcomponent FAILs and launches nothing (round 3 capture + composite)', async () => {
    for (const [status, text] of [[1, fx('codesign-verify-mas-notsigned.txt')], [0, `${fx('codesign-verify-mas-valid.txt')}\n${fx('codesign-sign-subcomponent.txt')}`]] as const) {
      const w = macWorld({ answers: { 'codesign --verify': ran(status, text) } });
      expect(await main([MAC_DIR], w.io)).toBe(1);
      expect(fails(w.out).join('\n')).toMatch(status === 1 ? /not signed at all/ : /In subcomponent: .*TN3270 Login Helper\.app/);
      expect(w.events).not.toContain('launch');
      expect(w.events.slice(-2)).toEqual([`rm ${CONTAINER}`, `rm ${MAC_WORK}`]);
    }
  });
  it('a signing failure, or no app-sandbox in the signature, FAILs and launches nothing', async () => {
    const signFails = macWorld({ answers: { 'codesign sign': (a) => (a.at(-1) === MAC_APP ? ran(1, `${MAC_APP}: code object is not signed at all`) : ok()) } });
    expect(await main([MAC_DIR], signFails.io)).toBe(1);
    expect(fails(signFails.out).join('\n')).toMatch(/signing \/scratch\/tn3270-store-probe-1\/TN3270\.app failed \(exit 1\)/);
    expect(signFails.events).not.toContain('launch');
    const noSandbox = macWorld({ answers: { 'codesign -d': ok(fx('codesign-d-entitlements-mas.txt').replace('<key>com.apple.security.app-sandbox</key><true/>', '')) } });
    expect(await main([MAC_DIR], noSandbox.io)).toBe(1);
    expect(fails(noSandbox.out).join('\n')).toMatch(/does not entitle com\.apple\.security\.app-sandbox.*not launched/);
    expect(noSandbox.events).not.toContain('launch');
  });
  it('a find that finds no helper apps FAILs (nothing signed is not "signed")', async () => {
    const w = macWorld({ answers: { 'find helpers': ok('') } });
    expect(await main([MAC_DIR], w.io)).toBe(1);
    expect(fails(w.out).join('\n')).toMatch(/found no helper apps to sign/);
  });
  it('cleanup runs after a throw: the launch throws, exit 2, and processes, container and scratch are still cleaned', async () => {
    const w = macWorld({ launch: async () => { throw new Error('cannot start /scratch/x: spawn EACCES'); } });
    expect(await main([MAC_DIR], w.io)).toBe(2);
    expect(w.out.join('\n')).toMatch(/store-probe: error: cannot start/);
    expect(w.events.slice(-4)).toEqual(['run ps', 'run kill', `rm ${CONTAINER}`, `rm ${MAC_WORK}`]);
  });
  it('a tool that cannot start (run throws) is exit 2, never a result; cleanup still runs', async () => {
    const w = macWorld({ answers: { 'codesign --verify': () => { throw new Error('cannot run codesign: spawn codesign ENOENT'); } } });
    expect(await main([MAC_DIR], w.io)).toBe(2);
    expect(w.out.join('\n')).toMatch(/store-probe: error: cannot run codesign: spawn codesign ENOENT/);
    expect(w.events).not.toContain('launch');
    expect(w.events.slice(-2)).toEqual([`rm ${CONTAINER}`, `rm ${MAC_WORK}`]);
  });
  it('each cleanup failure is a FAIL line, and the later steps still run', async () => {
    const w = macWorld({ answers: { ps: ran(1, 'ps: broken') } });
    expect(await main([MAC_DIR], w.io)).toBe(1);
    expect(fails(w.out)).toEqual(['FAIL mac-sandbox: cleanup processes: ps failed (exit 1): ps: broken']);
    expect(w.events.slice(-2)).toEqual([`rm ${CONTAINER}`, `rm ${MAC_WORK}`]);
  });
  it('survivors of the confinement launch FAIL it', async () => {
    const w = macWorld({ launched: { survivors: ['process group 4242'] } });
    expect(await main([MAC_DIR], w.io)).toBe(1);
    expect(fails(w.out)).toEqual(['FAIL mac-sandbox: confinement launch: survived the kill: process group 4242']);
  });
  it('a home that is / never removes anything outside the scratch: exit 2', async () => {
    const w = macWorld({ io: { home: '/' } });
    expect(await main([MAC_DIR], w.io)).toBe(2);
    expect(w.events.filter((e) => e.startsWith('rm '))).toEqual([`rm ${MAC_WORK}`]);
    expect(w.out.join('\n')).toMatch(/refusing to remove/);
  });
  it('STORE_PROBE_ECHO=1 logs each command and its raw output', async () => {
    const w = macWorld({ io: { env: { STORE_PROBE_ECHO: '1' } } });
    expect(await main([MAC_DIR], w.io)).toBe(0);
    expect(w.out).toContain(`$ codesign --verify --deep --strict --verbose=2 ${MAC_APP}`);
    expect(w.out.join('\n')).toMatch(/valid on disk\n.*satisfies its Designated Requirement\n\[exit 0\]/);
    expect(w.out.join('\n')).toMatch(/confinement launch output:\nprobe: sandbox=io\.github\.athornton\.tn3270 windowsStore=false/);
  });
});

describe('removeContainer: ONLY <home>/Library/Containers/io.github.athornton.tn3270', () => {
  const fsFake = () => { const rm: string[] = []; return { rm, fs: { rm: (p: string) => { rm.push(p); }, exists: () => false } }; };
  it('removes exactly the container, compared as normalized posix paths', () => {
    for (const p of [CONTAINER, `${CONTAINER}/`, `${HOME}/Library/./Containers/io.github.athornton.tn3270`]) {
      const f = fsFake();
      removeContainer({ home: HOME, fs: f.fs }, p);
      expect(f.rm).toEqual([CONTAINER]);
    }
  });
  it('refuses, before removing anything, every other path and an unusable home', () => {
    const cases: [string, string][] = [
      [HOME, `${HOME}/Library/Containers`], [HOME, `${HOME}/Library/Containers/com.example.other`], [HOME, `${CONTAINER}/../com.example.other`],
      [HOME, `${CONTAINER}/Data`], [HOME, HOME], [HOME, '/'], [HOME, `/Users/other/Library/Containers/io.github.athornton.tn3270`],
      ['/', '/Library/Containers/io.github.athornton.tn3270'], ['Users/runner', 'Users/runner/Library/Containers/io.github.athornton.tn3270'],
      ['', '/Library/Containers/io.github.athornton.tn3270'], ['/Users/runner/../..', '/Library/Containers/io.github.athornton.tn3270'],
    ];
    for (const [home, p] of cases) {
      const f = fsFake();
      expect(() => removeContainer({ home, fs: f.fs }, p), `${home} ${p}`).toThrow(/refusing to remove/);
      expect(f.rm).toEqual([]);
    }
  });
  it('a container still there after removal throws', () => {
    expect(() => removeContainer({ home: HOME, fs: { rm: () => {}, exists: () => true } }, CONTAINER)).toThrow(/still exists/);
  });
});

describe('main on Windows (a port of win-appx.ps1)', () => {
  it('happy path: the spike\'s steps in its order, confined by the alias, both checks ok, cleanup, exit 0', async () => {
    const w = winWorld();
    expect(await main([WIN_DIR], w.io)).toBe(0);
    expect(w.events.filter((e) => e.startsWith('run ') || e === 'launch' || e.startsWith('check ') || e.startsWith('rm ')).map((e) => e.replace(/ C:\\.*$/, ''))).toEqual([
      'run certificate', 'run signtool', 'run Add-AppxPackage', 'run Get-AppxPackage', 'run alias',
      'launch', 'run GetPackageFullName', 'check drawsGolden', 'check dialogConnects',
      'run reap', 'run Remove-AppxPackage', 'run cert-remove My', 'run cert-remove TrustedPeople',
      'rm', 'rm', 'rm',
    ]);
    const appx = `${WIN_WORK}\\TN3270-0.1.4-win-x64.appx`;
    expect(w.events).toContain(`copy ${WIN_DIR}\\TN3270-0.1.4-win-x64.appx ${appx}`);
    expect(w.calls.find((c) => c[0] === SIGNTOOL)).toEqual([SIGNTOOL, 'sign', '/fd', 'SHA256', '/f', `${WIN_WORK}\\probe.pfx`, '/p', PW, appx]);
    expect(w.events.filter((e) => e.startsWith('rm '))).toEqual([`rm ${WIN_WORK}\\probe.pfx`, `rm ${WIN_WORK}\\probe.cer`, `rm ${WIN_WORK}`]);
    const psCall = (kind: string) => w.calls.find((c) => c[0] === 'powershell' && psKind(psScript(c)) === kind)!;
    const ps = (kind: string) => psScript(psCall(kind));
    expect(ps('certificate')).toContain("-Subject 'CN=TN3270 Store Probe' -KeyUsage DigitalSignature -CertStoreLocation Cert:\\CurrentUser\\My -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')");
    expect(ps('certificate')).toContain('Import-Certificate -FilePath');
    expect(ps('certificate')).toContain('-CertStoreLocation Cert:\\LocalMachine\\TrustedPeople');
    expect(ps('Add-AppxPackage')).toContain(`Add-AppxPackage -Path '${appx}' -ErrorAction Stop`);
    expect(ps('Get-AppxPackage')).toContain("Get-AppxPackage -Name 'TN3270.Probe' | ConvertTo-Json -Compress");
    expect(ps('GetPackageFullName')).toMatch(/\[StoreProbePkg\]::Of\(828\)$/);
    expect(ps('reap')).toContain(`$d = '${INSTALL}'`);
    expect(ps('cert-remove My')).toContain(`Cert:\\CurrentUser\\My\\${THUMB}`);
    expect(ps('cert-remove TrustedPeople')).toContain(`Cert:\\LocalMachine\\TrustedPeople\\${THUMB}`);
    expect(w.routes[0]).toMatchObject({ exe: ALIAS, probe: true, processDir: INSTALL });
    expect(w.launchArgs[0]!.at(-1)).toBe(`--user-data-dir=${WIN_WORK}\\confine-user-data`);
    expect(fails(w.out)).toEqual([]);
    expect(w.out.filter((l) => l.startsWith('ok '))).toEqual([
      'ok win-msix: confined (the app reports windowsStore=true; the alias-started process is TN3270.Probe_0.1.4.0_x64__5j71tdef09jdy)',
      'ok win-msix: replays a trace and draws the synthetic-ispf golden',
      'ok win-msix: with no host, opens the Connect dialog and connects',
    ]);
    for (const p of ['certificate', 'sign', 'install', 'confine', 'check drawsGolden', 'check dialogConnects', 'cleanup', 'total']) {
      expect(w.out.some((l) => new RegExp(`^time ${p}: \\d+\\.\\ds$`).test(l)), p).toBe(true);
    }
  });
  it('signtool is the newest SDK one by parsed version, never by string order; none is exit 2', async () => {
    expect(newestSdkTool(['10.0.9999.0', '10.0.26100.0', '10.0.17763.0', 'arm64'], () => true)).toBe(SIGNTOOL);
    expect(newestSdkTool(['10.0.26100.0', '10.0.17763.0'], (p) => !p.includes('26100'))).toBe(`${SDK}\\10.0.17763.0\\x64\\signtool.exe`);
    expect(newestSdkTool(['arm64', '10.0'], () => true)).toBeNull();
    const w = winWorld({ sdk: [] });
    expect(await main([WIN_DIR], w.io)).toBe(2);
    expect(w.out.join('\n')).toMatch(/no Windows SDK signtool/);
    expect(w.calls).toEqual([]);
  });
  it('the alias not found after the install: exit 2, and the cleanup still removes everything', async () => {
    const w = winWorld({ ps: { alias: ok('alias=\n') } });
    expect(await main([WIN_DIR], w.io)).toBe(2);
    expect(w.out.join('\n')).toMatch(/store-probe: the app execution alias tn3270-gui\.exe is not on PATH after Add-AppxPackage/);
    expect(w.events).not.toContain('launch');
    for (const e of ['run reap', 'run Remove-AppxPackage', 'run cert-remove My', 'run cert-remove TrustedPeople', `rm ${WIN_WORK}\\probe.pfx`]) at(w.events, e);
  });
  it('Add-AppxPackage failing: exit 1, and Remove-AppxPackage, both certificate removals and the pfx all still run', async () => {
    const w = winWorld({ ps: { 'Add-AppxPackage': ran(1, 'Add-AppxPackage: FAILED Deployment failed with HRESULT: 0x800B0100') } });
    expect(await main([WIN_DIR], w.io)).toBe(1);
    expect(fails(w.out)).toEqual(['FAIL win-msix: Add-AppxPackage failed (exit 1): Add-AppxPackage: FAILED Deployment failed with HRESULT: 0x800B0100']);
    const after = w.events.slice(at(w.events, 'run Add-AppxPackage') + 1);
    expect(after.filter((e) => e.startsWith('run ') || e.startsWith('rm '))).toEqual([
      'run Remove-AppxPackage', 'run cert-remove My', 'run cert-remove TrustedPeople', `rm ${WIN_WORK}\\probe.pfx`, `rm ${WIN_WORK}\\probe.cer`, `rm ${WIN_WORK}`,
    ]);
  });
  it('each cleanup step runs even when the one before it failed, each failure logged', async () => {
    const w = winWorld({ ps: { 'Remove-AppxPackage': ran(1, 'still installed'), 'cert-remove My': () => { throw new Error('cannot run powershell: spawn powershell ENOENT'); } } });
    expect(await main([WIN_DIR], w.io)).toBe(1);
    expect(fails(w.out)).toEqual([
      'FAIL win-msix: cleanup Remove-AppxPackage: exit 1: still installed',
      'FAIL win-msix: cleanup certificate Cert:\\CurrentUser\\My: cannot run powershell: spawn powershell ENOENT',
    ]);
    for (const e of ['run cert-remove TrustedPeople', `rm ${WIN_WORK}\\probe.pfx`, `rm ${WIN_WORK}\\probe.cer`, `rm ${WIN_WORK}`]) at(w.events, e);
  });
  it('the certificate not made: exit 2; without a thumbprint the cleanup removes ours by subject and name', async () => {
    const w = winWorld({ ps: { certificate: ran(1, 'New-SelfSignedCertificate : Access denied') } });
    expect(await main([WIN_DIR], w.io)).toBe(2);
    expect(w.out.join('\n')).toMatch(/throwaway certificate was not made and trusted \(exit 1\): New-SelfSignedCertificate : Access denied/);
    const rms = w.calls.filter((c) => c[0] === 'powershell' && psKind(psScript(c)).startsWith('cert-remove')).map(psScript);
    expect(rms).toHaveLength(2);
    for (const s of rms) expect(s).toContain("$_.Subject -eq 'CN=TN3270 Store Probe' -and $_.FriendlyName -eq 'TN3270 store probe'");
  });
  it('FAIL-CLOSED: windowsStore=false from the confinement launch is exit 1, checks not run', async () => {
    const w = winWorld({ launched: { stdout: 'probe: sandbox=none windowsStore=false\n' } });
    expect(await main([WIN_DIR], w.io)).toBe(1);
    expect(fails(w.out)).toEqual(['FAIL win-msix: the app reports windowsStore=false: it has no package identity']);
    expect(w.events.some((e) => e.startsWith('check '))).toBe(false);
  });
  it('FAIL-CLOSED: a check reporting windowsStore=false, or no probe line, FAILs', async () => {
    for (const line of ['probe: sandbox=none windowsStore=false', null]) {
      const events: string[] = [];
      const w = winWorld({ io: { checks: fakeChecks(events, (i) => (i === 0 ? line : WIN_LINE)) } });
      expect(await main([WIN_DIR], w.io)).toBe(1);
      expect(fails(w.out)).toHaveLength(1);
      expect(fails(w.out)[0]).toMatch(line === null ? /confinement is unproven/ : /windowsStore=false/);
    }
  });
  it('the alias-started process with another package (or none) FAILs the confinement', async () => {
    const w = winWorld({ ps: { GetPackageFullName: ok('none (APPMODEL_ERROR_NO_PACKAGE)\n') } });
    expect(await main([WIN_DIR], w.io)).toBe(1);
    expect(fails(w.out).join('\n')).toMatch(/package is none \(APPMODEL_ERROR_NO_PACKAGE\)/);
  });
  it('STORE_PROBE_ECHO=1 logs the commands and output, with the pfx password masked', async () => {
    const w = winWorld({ io: { env: { STORE_PROBE_ECHO: '1' } } });
    expect(await main([WIN_DIR], w.io)).toBe(0);
    const log = w.out.join('\n');
    expect(log).not.toContain(PW);
    expect(log).toContain(`$ ${SIGNTOOL} sign /fd SHA256 /f ${WIN_WORK}\\probe.pfx /p *** ${WIN_WORK}\\TN3270-0.1.4-win-x64.appx`);
    expect(log).toMatch(/Successfully signed: .*\n\[exit 0\]/);
    // A PowerShell step is echoed as its script, not its base64; the password masked there too.
    expect(log).toMatch(/\$ powershell -EncodedCommand <<\n\$ErrorActionPreference = 'Stop'.*\n\$c = New-SelfSignedCertificate/);
    expect(log).toContain("-String '***' -Force -AsPlainText");
  });
});

describe('main: target-platform paths on a Linux host (both platforms)', () => {
  it('darwin builds / paths and win32 builds \\ paths, whatever the host', async () => {
    const m = macWorld();
    expect(await main([MAC_DIR], m.io)).toBe(0);
    for (const c of m.calls.filter((x) => x[0] === 'codesign')) expect(c.at(-1)!, c.join(' ')).toMatch(/^\/scratch\/[^\\]*$/);
    const w = winWorld();
    expect(await main([WIN_DIR], w.io)).toBe(0);
    expect(w.calls.find((c) => c[0] === SIGNTOOL)!.at(-1)).toBe(`${WIN_WORK}\\TN3270-0.1.4-win-x64.appx`);
  });
});

describe('launchForProbe (the real confinement launch, on a fake app)', () => {
  const FAKE_APP = `
if (process.env.TN3270_GUI_PROBE === '1') process.stdout.write('probe: sandbox=fake.id windowsStore=false\\n');
setInterval(() => {}, 1000); // stays up, as the app does with its Connect dialog, until killed
`;
  it('waits for the probe line, calls whileRunning with the LIVE pid, then kills it by PID: no survivor', async () => {
    const saved = process.env.DISPLAY;
    process.env.DISPLAY = saved ?? ':fake'; // displayEnv passes a set DISPLAY through; unset, it would start Xvfb
    const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'storeprobe-')));
    try {
      const app = join(tmp, 'fake-app.cjs');
      writeFileSync(app, FAKE_APP);
      const route = { exe: process.execPath, prefix: [app], env: {}, installDir: tmp, probe: true };
      let seen = -1;
      let aliveThen = false;
      const l = await launchForProbe(route, [], {
        work: tmp,
        whileRunning: (pid) => { seen = pid; try { process.kill(pid, 0); aliveThen = true; } catch { aliveThen = false; } return 'measured'; },
      });
      expect(l.stdout).toContain('probe: sandbox=fake.id windowsStore=false');
      expect(l.during).toBe('measured');
      expect(aliveThen).toBe(true);
      expect(l.survivors).toEqual([]);
      expect(() => process.kill(seen, 0)).toThrow();
    } finally {
      if (saved === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = saved;
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 60_000);
  it('an app that cannot start THROWS (exit 2), it is never a result', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'storeprobe-'));
    try {
      await expect(launchForProbe({ exe: join(tmp, 'no-such-app'), prefix: [], env: {}, installDir: tmp }, [], { work: tmp }))
        .rejects.toThrow(/cannot start .*no-such-app/);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }, 60_000);
});
