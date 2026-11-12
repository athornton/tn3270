import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  BUNDLE_ID, CheckFailed, IDENTITY_NAME, PUBLISHER, TEAM_ID, containerPath, judgeMacConfinement, judgeSignatureVerify, judgeWinConfinement,
  launchForProbe, macRoute, main, newestSdkTool, parseAppxPackage, parseProbeLine, removeContainer, winRoute,
  PS_PREAMBLE, STAY_MS, parseInstalled, pidsUnder, psAlias, psCertificate, psInstall, psInstalled, psListPackage, psPackageOfPid, psQuote,
  psReap, psRemoveCert, psUninstall, setTeamId, signInsideOut, nodeFs, type Ran,
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
      ['ps', '-ww', '-axo', 'pid=,comm='], // re-listed: none of ours is left
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
    expect(w.events.slice(-5)).toEqual(['run ps', 'run kill', 'run ps', `rm ${CONTAINER}`, `rm ${MAC_WORK}`]);
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
      'run installed', 'run certificate', 'run signtool', 'run Add-AppxPackage', 'run Get-AppxPackage', 'run alias',
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
    // The cleanup runs the builders' exact scripts: our processes (install dir, started pid), the
    // EXACT installed full name, our thumbprint in both stores.
    expect(ps('reap')).toBe(`${PS_PREAMBLE}\n${psReap(INSTALL, [828])}`);
    expect(ps('Remove-AppxPackage')).toBe(`${PS_PREAMBLE}\n${psUninstall('TN3270.Probe_0.1.4.0_x64__5j71tdef09jdy')}`);
    expect(ps('cert-remove My')).toBe(`${PS_PREAMBLE}\n${psRemoveCert('Cert:\\CurrentUser\\My', THUMB)}`);
    expect(ps('cert-remove TrustedPeople')).toBe(`${PS_PREAMBLE}\n${psRemoveCert('Cert:\\LocalMachine\\TrustedPeople', THUMB)}`);
    expect(ps('installed')).toBe(`${PS_PREAMBLE}\n${psInstalled()}`);
    expect(ps('certificate')).toBe(`${PS_PREAMBLE}\n${psCertificate({ pfx: `${WIN_WORK}\\probe.pfx`, cer: `${WIN_WORK}\\probe.cer`, password: PW })}`);
    expect(ps('alias')).toBe(`${PS_PREAMBLE}\n${psAlias()}`);
    expect(ps('Get-AppxPackage')).toBe(`${PS_PREAMBLE}\n${psListPackage()}`);
    expect(ps('GetPackageFullName')).toBe(`${PS_PREAMBLE}\n${psPackageOfPid(828)}`);
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
    expect(w.events.filter((e) => e.startsWith('run '))).toEqual(['run installed']);
  });
  it('the alias not found after the install: exit 2, and the cleanup still removes everything', async () => {
    const w = winWorld({ ps: { alias: ok('alias=\n') } });
    expect(await main([WIN_DIR], w.io)).toBe(2);
    expect(w.out.join('\n')).toMatch(/store-probe: the app execution alias tn3270-gui\.exe is not on PATH after Add-AppxPackage/);
    expect(w.events).not.toContain('launch');
    for (const e of ['run reap', 'run Remove-AppxPackage', 'run cert-remove My', 'run cert-remove TrustedPeople', `rm ${WIN_WORK}\\probe.pfx`]) at(w.events, e);
  });
  it('Add-AppxPackage failing: exit 1, and Remove-AppxPackage (of what it left, by full name), both certificate removals and the pfx all still run', async () => {
    let adds = 0;
    const w = winWorld({ ps: {
      'Add-AppxPackage': () => { adds++; return ran(1, 'Add-AppxPackage: FAILED Deployment failed with HRESULT: 0x800B0100'); },
      // Nothing before the install; a half-installed package after it.
      installed: () => ok(adds === 0 ? '' : 'installed=TN3270.Probe_0.1.4.0_x64__5j71tdef09jdy\n'),
    } });
    expect(await main([WIN_DIR], w.io)).toBe(1);
    expect(fails(w.out)).toEqual(['FAIL win-msix: Add-AppxPackage failed (exit 1): Add-AppxPackage: FAILED Deployment failed with HRESULT: 0x800B0100']);
    const after = w.events.slice(at(w.events, 'run Add-AppxPackage') + 1);
    expect(after.filter((e) => e.startsWith('run ') || e.startsWith('rm '))).toEqual([
      'run installed', 'run Remove-AppxPackage', 'run cert-remove My', 'run cert-remove TrustedPeople', `rm ${WIN_WORK}\\probe.pfx`, `rm ${WIN_WORK}\\probe.cer`, `rm ${WIN_WORK}`,
    ]);
    const uninstall = w.calls.filter((c) => c[0] === 'powershell' && psKind(psScript(c)) === 'Remove-AppxPackage').map(psScript);
    expect(uninstall).toEqual([`${PS_PREAMBLE}\n${psUninstall('TN3270.Probe_0.1.4.0_x64__5j71tdef09jdy')}`]);
  });
  it('each cleanup step runs even when the one before it failed, each failure logged', async () => {
    const w = winWorld({ ps: { 'Remove-AppxPackage': ran(1, 'still installed'), 'cert-remove My': () => { throw new Error('cannot run powershell: spawn powershell ENOENT'); } } });
    expect(await main([WIN_DIR], w.io)).toBe(1);
    expect(fails(w.out)).toEqual([
      'FAIL win-msix: cleanup Remove-AppxPackage: TN3270.Probe_0.1.4.0_x64__5j71tdef09jdy: exit 1: still installed',
      'FAIL win-msix: cleanup certificate Cert:\\CurrentUser\\My: cannot run powershell: spawn powershell ENOENT',
    ]);
    for (const e of ['run cert-remove TrustedPeople', `rm ${WIN_WORK}\\probe.pfx`, `rm ${WIN_WORK}\\probe.cer`, `rm ${WIN_WORK}`]) at(w.events, e);
  });
  it('the certificate not made: exit 2; without a thumbprint the cleanup removes ours by SUBJECT (not FriendlyName) from both stores', async () => {
    const w = winWorld({ ps: { certificate: ran(1, 'New-SelfSignedCertificate : Access denied') } });
    expect(await main([WIN_DIR], w.io)).toBe(2);
    expect(w.out.join('\n')).toMatch(/throwaway certificate was not made and trusted \(exit 1\): New-SelfSignedCertificate : Access denied/);
    const rms = w.calls.filter((c) => c[0] === 'powershell' && psKind(psScript(c)).startsWith('cert-remove')).map(psScript);
    expect(rms).toHaveLength(2);
    expect(rms).toEqual([`${PS_PREAMBLE}\n${psRemoveCert('Cert:\\CurrentUser\\My', null)}`, `${PS_PREAMBLE}\n${psRemoveCert('Cert:\\LocalMachine\\TrustedPeople', null)}`]);
    for (const x of rms) expect(x).not.toContain('FriendlyName');
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

// ---------------------------------------------------------------------------------------------
// Review fixes (2026-11-12): the pure builders' EXACT text, the safety refusals, and the branches.

const lines = (...ls: string[]) => ls.join('\n');
const FULL = 'TN3270.Probe_0.1.4.0_x64__5j71tdef09jdy';

describe('PowerShell builders: the exact scripts', () => {
  it('psReap: ours is under EXACTLY the install dir (trailing \\), or a started pid that is still TN3270.exe; re-listed; a leftover throws', () => {
    expect(psReap(INSTALL, [828])).toBe(lines(
      String.raw`$dir = 'C:\Program Files\WindowsApps\TN3270.Probe_0.1.4.0_x64__5j71tdef09jdy\'`,
      '$ids = @(828)',
      String.raw`$ours = { param($p) $p.ExecutablePath -and (($dir -and $p.ExecutablePath.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase)) -or (($ids -contains [int]$p.ProcessId) -and $p.ExecutablePath.EndsWith('\TN3270.exe', [StringComparison]::OrdinalIgnoreCase))) }`,
      '$found = @(Get-CimInstance Win32_Process | Where-Object { & $ours $_ })',
      'foreach ($p in $found) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; "killed $($p.ProcessId) $($p.ExecutablePath)" }',
      'if ($found.Count -gt 0) { Start-Sleep -Seconds 2 }',
      '$left = @(Get-CimInstance Win32_Process | Where-Object { & $ours $_ })',
      `if ($left.Count -gt 0) { throw "still running after Stop-Process: $(($left | ForEach-Object { $_.ProcessId }) -join ' ')" }`,
    ));
    // No install location: only the started pids (still TN3270.exe); no pids and no dir match nothing.
    expect(psReap(null, [828]).split('\n')[0]).toBe('$dir = $null');
    expect(psReap(`${INSTALL}\\`, []).split('\n').slice(0, 2)).toEqual([String.raw`$dir = 'C:\Program Files\WindowsApps\TN3270.Probe_0.1.4.0_x64__5j71tdef09jdy\'`, '$ids = @()']);
  });
  it('psUninstall: exactly the full name, then checks that full name is gone', () => {
    expect(psUninstall(FULL)).toBe(lines(
      `Remove-AppxPackage -Package '${FULL}'`,
      `if (@(Get-AppxPackage -Name 'TN3270.Probe' | Where-Object { $_.PackageFullName -eq '${FULL}' }).Count -gt 0) { throw 'still installed: ${FULL}' }`,
      `'removed ${FULL}'`,
    ));
  });
  it('psRemoveCert by thumbprint: -DeleteKey in CurrentUser\\My only, and a Test-Path re-check that throws', () => {
    expect(psRemoveCert('Cert:\\CurrentUser\\My', THUMB)).toBe(lines(
      String.raw`$p = 'Cert:\CurrentUser\My\4E7733D6F453C85023DF5488E7B8A9964885E700'`,
      'if (Test-Path -LiteralPath $p) { Remove-Item -Path $p -DeleteKey }',
      String.raw`if (Test-Path -LiteralPath $p) { throw 'still there: Cert:\CurrentUser\My\4E7733D6F453C85023DF5488E7B8A9964885E700' }`,
      String.raw`'removed Cert:\CurrentUser\My\4E7733D6F453C85023DF5488E7B8A9964885E700'`,
    ));
    expect(psRemoveCert('Cert:\\LocalMachine\\TrustedPeople', THUMB)).toBe(lines(
      String.raw`$p = 'Cert:\LocalMachine\TrustedPeople\4E7733D6F453C85023DF5488E7B8A9964885E700'`,
      'if (Test-Path -LiteralPath $p) { Remove-Item -Path $p }',
      String.raw`if (Test-Path -LiteralPath $p) { throw 'still there: Cert:\LocalMachine\TrustedPeople\4E7733D6F453C85023DF5488E7B8A9964885E700' }`,
      String.raw`'removed Cert:\LocalMachine\TrustedPeople\4E7733D6F453C85023DF5488E7B8A9964885E700'`,
    ));
  });
  it('psRemoveCert without a thumbprint: by our exact SUBJECT (FriendlyName does not survive Export/Import); none found throws', () => {
    expect(psRemoveCert('Cert:\\LocalMachine\\TrustedPeople', null)).toBe(lines(
      String.raw`$c = @(Get-ChildItem -Path 'Cert:\LocalMachine\TrustedPeople' | Where-Object { $_.Subject -eq 'CN=TN3270 Store Probe' })`,
      String.raw`if ($c.Count -eq 0) { throw 'no certificate with subject CN=TN3270 Store Probe in Cert:\LocalMachine\TrustedPeople, and one was expected' }`,
      'foreach ($x in $c) { Remove-Item -Path $x.PSPath }',
      String.raw`if (@(Get-ChildItem -Path 'Cert:\LocalMachine\TrustedPeople' | Where-Object { $_.Subject -eq 'CN=TN3270 Store Probe' }).Count -gt 0) { throw 'still there: subject CN=TN3270 Store Probe in Cert:\LocalMachine\TrustedPeople' }`,
      '"removed $($c.Count) by subject"',
    ));
    expect(psRemoveCert('Cert:\\CurrentUser\\My', null)).toContain('foreach ($x in $c) { Remove-Item -Path $x.PSPath -DeleteKey }');
  });
  it('psCertificate: the spike\'s flags, the thumbprint first, the TrustedPeople check', () => {
    expect(psCertificate({ pfx: 'C:\\w\\probe.pfx', cer: 'C:\\w\\probe.cer', password: 'pw' })).toBe(lines(
      String.raw`$c = New-SelfSignedCertificate -Type Custom -Subject 'CN=TN3270 Store Probe' -KeyUsage DigitalSignature -CertStoreLocation Cert:\CurrentUser\My -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}') -FriendlyName 'TN3270 store probe'`,
      'Write-Output "thumbprint=$($c.Thumbprint)"',
      String.raw`Export-PfxCertificate -Cert "Cert:\CurrentUser\My\$($c.Thumbprint)" -FilePath 'C:\w\probe.pfx' -Password (ConvertTo-SecureString -String 'pw' -Force -AsPlainText) | Out-Null`,
      String.raw`Export-Certificate -Cert "Cert:\CurrentUser\My\$($c.Thumbprint)" -FilePath 'C:\w\probe.cer' | Out-Null`,
      String.raw`Import-Certificate -FilePath 'C:\w\probe.cer' -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null`,
      String.raw`if (-not (Test-Path "Cert:\LocalMachine\TrustedPeople\$($c.Thumbprint)")) { throw "the certificate is not in LocalMachine\TrustedPeople" }`,
    ));
  });
  it('psInstall, psAlias, psInstalled, psListPackage', () => {
    expect(psInstall('C:\\w\\a.appx').split('\n')[0]).toBe(String.raw`try { Add-AppxPackage -Path 'C:\w\a.appx' -ErrorAction Stop; 'Add-AppxPackage: OK' }`);
    expect(psInstall('C:\\w\\a.appx')).toContain('Get-AppPackageLog -ActivityID $aid');
    expect(psInstall('C:\\w\\a.appx').split('\n').at(-2)).toBe('  exit 1');
    expect(psAlias()).toBe(lines(
      '$c = Get-Command tn3270-gui.exe -ErrorAction SilentlyContinue',
      'if ($c) { "alias=$($c.Source)" } else {',
      String.raw`  $f = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\tn3270-gui.exe'`,
      '  if (Test-Path $f) { "alias=$f" } else { "alias=" }',
      '}',
    ));
    expect(psInstalled()).toBe(`@(Get-AppxPackage -Name 'TN3270.Probe') | ForEach-Object { "installed=$($_.PackageFullName)" }`);
    expect(parseInstalled(`installed=${FULL}\r\ninstalled=TN3270.Probe_0.1.3.0_x64__5j71tdef09jdy\nnoise\n`)).toEqual([FULL, 'TN3270.Probe_0.1.3.0_x64__5j71tdef09jdy']);
    expect(parseInstalled('')).toEqual([]);
    expect(psListPackage()).toBe("Get-AppxPackage -Name 'TN3270.Probe' | ConvertTo-Json -Compress");
    expect(psPackageOfPid(828).split('\n').at(-1)).toBe('[StoreProbePkg]::Of(828)');
  });
  it('psQuote doubles \' and U+2018-U+201B (PowerShell quotes them all)', () => {
    expect(psQuote("a'b")).toBe("'a''b'");
    expect(psQuote('a\u2018b\u2019c\u201Ad\u201Be')).toBe("'a\u2018\u2018b\u2019\u2019c\u201A\u201Ad\u201B\u201Be'");
    expect(psInstall('C:\\it\u2019s.appx')).toContain("-Path 'C:\\it\u2019\u2019s.appx'");
  });
});

describe('mac builders: signInsideOut, setTeamId, pidsUnder', () => {
  const recorder = (answer: (cmd: string, args: string[]) => Ran | undefined = () => undefined) => {
    const calls: string[][] = [];
    const finds: Record<string, string[]> = { '*.dylib': MAC_FIND.dylibs, '*.framework': MAC_FIND.frameworks, '*.app': MAC_FIND.helpers, '-u+x': MAC_FIND.login };
    const run = (cmd: string, args: string[]): Ran => {
      calls.push([cmd, ...args]);
      const a = answer(cmd, args);
      if (a) return a;
      if (cmd === 'find') return ok(`${finds[args.at(-1)!]!.join('\n')}\n`);
      return ok();
    };
    return { calls, run };
  };
  const ENT = { main: '/r/main.plist', inherit: '/r/inherit.plist', login: '/r/login.plist' };
  const fs = { exists: (p: string) => p === `${MAC_APP}/Contents/Library/LoginItems`, list: () => ['TN3270 Login Helper.app', 'README'] };
  it('signs inside out with the right entitlements, the app last', () => {
    const r = recorder();
    expect(signInsideOut(MAC_APP, ENT, { run: r.run, fs })).toEqual([]);
    expect(r.calls.filter((c) => c[0] === 'codesign')).toEqual([
      ...MAC_FIND.dylibs.map((f) => ['codesign', '--force', '-s', '-', f]),
      ...MAC_FIND.frameworks.map((f) => ['codesign', '--force', '--deep', '-s', '-', f]),
      ...MAC_FIND.helpers.map((f) => ['codesign', '--force', '-s', '-', '--entitlements', '/r/inherit.plist', f]),
      ...MAC_FIND.login.map((f) => ['codesign', '--force', '-s', '-', '--entitlements', '/r/login.plist', f]),
      ['codesign', '--force', '-s', '-', '--entitlements', '/r/login.plist', LOGIN_HELPER],
      ['codesign', '--force', '-s', '-', '--entitlements', '/r/main.plist', MAC_APP],
    ]);
  });
  it('every failure is collected and every step still runs; no login items is fine', () => {
    const r = recorder((cmd, args) => (cmd === 'find' && args.includes('*.framework') ? ran(1, 'find: permission denied') : cmd === 'codesign' && args.at(-1) === MAC_APP ? ran(1, 'boom') : undefined));
    const p = signInsideOut(MAC_APP, ENT, { run: r.run, fs: { exists: () => false, list: () => [] } });
    expect(p).toEqual([`find frameworks failed (exit 1): find: permission denied`, `signing ${MAC_APP} failed (exit 1): boom`]);
    expect(r.calls.at(-1)).toEqual(['codesign', '--force', '-s', '-', '--entitlements', '/r/main.plist', MAC_APP]);
  });
  it('setTeamId: Add, else Set, and the read-back must be the team id', () => {
    expect(setTeamId(MAC_APP, recorder((cmd, a) => (a[1]!.startsWith('Print') ? ok('H68TN685J4\n') : undefined)).run)).toEqual([]);
    expect(setTeamId(MAC_APP, recorder((cmd, a) => (a[1]!.startsWith('Print') ? ok('ZZZZZ99999\n') : undefined)).run)).toEqual(['ElectronTeamID reads back as ZZZZZ99999, not H68TN685J4']);
    expect(setTeamId(MAC_APP, recorder((cmd, a) => (a[1]!.startsWith('Print') ? ran(1, 'Print: Entry, ":ElectronTeamID", Does Not Exist') : ran(1, 'nope'))).run))
      .toEqual(['PlistBuddy could not add or set ElectronTeamID (exit 1): nope', 'ElectronTeamID reads back as Print: Entry, ":ElectronTeamID", Does Not Exist, not H68TN685J4']);
  });
  it('pidsUnder: only executables inside the scratch (as given, or under /private)', () => {
    expect(pidsUnder(`  1 ${MAC_WORK}/TN3270.app/x\n  2 ${MAC_WORK}-other/TN3270.app/x\n  3 /private${MAC_WORK}/y\n  4 /usr/bin/z\n`, MAC_WORK)).toEqual(['1', '3']);
  });
});

describe('safety: never touch a real user\'s app (CI=true or STORE_PROBE_FORCE=1 allow it)', () => {
  it('mac: an existing container is refused, exit 2, nothing run and nothing removed', async () => {
    const w = macWorld({ containerBefore: true });
    expect(await main([MAC_DIR], w.io)).toBe(2);
    expect(w.out.join('\n')).toMatch(/refusing to run: \/Users\/runner\/Library\/Containers\/io\.github\.athornton\.tn3270 already exists/);
    expect(w.calls).toEqual([]);
    expect(w.events.filter((e) => e.startsWith('rm ') || e.startsWith('mkdtemp'))).toEqual([]);
  });
  it.each([[{ CI: 'true' }], [{ STORE_PROBE_FORCE: '1' }]])('mac: %o lets the existing container be removed and the probe run', async (env) => {
    const w = macWorld({ containerBefore: true, io: { env } });
    expect(await main([MAC_DIR], w.io)).toBe(0);
    expect(at(w.events, `rm ${CONTAINER}`)).toBeLessThan(at(w.events, 'run ditto'));
  });
  it('mac: CI other than "true", or FORCE other than "1", still refuses', async () => {
    for (const env of [{ CI: '1' }, { STORE_PROBE_FORCE: 'yes' }]) expect(await main([MAC_DIR], macWorld({ containerBefore: true, io: { env } }).io)).toBe(2);
  });
  it('win: an installed TN3270.Probe is refused, exit 2, nothing installed or removed', async () => {
    const w = winWorld({ ps: { installed: ok(`installed=${FULL}\n`) } });
    expect(await main([WIN_DIR], w.io)).toBe(2);
    expect(w.out.join('\n')).toMatch(new RegExp(`refusing to run: ${FULL.replace(/\./g, '\\.')} is already installed`));
    expect(w.events.filter((e) => e.startsWith('run '))).toEqual(['run installed']);
  });
  it.each([[{ CI: 'true' }], [{ STORE_PROBE_FORCE: '1' }]])('win: %o removes the stale package by its exact full name first, then runs', async (env) => {
    let n = 0;
    const w = winWorld({ ps: { installed: () => ok(n++ === 0 ? 'installed=TN3270.Probe_0.1.3.0_x64__5j71tdef09jdy\n' : '') }, io: { env } });
    expect(await main([WIN_DIR], w.io)).toBe(0);
    const uninstalls = w.calls.filter((c) => c[0] === 'powershell' && psKind(psScript(c)) === 'Remove-AppxPackage').map(psScript);
    expect(uninstalls).toEqual([`${PS_PREAMBLE}\n${psUninstall('TN3270.Probe_0.1.3.0_x64__5j71tdef09jdy')}`, `${PS_PREAMBLE}\n${psUninstall(FULL)}`]);
    expect(at(w.events, 'run Remove-AppxPackage')).toBeLessThan(at(w.events, 'run certificate'));
  });
  it('win: the installed-package query failing is exit 2 (it cannot tell)', async () => {
    const w = winWorld({ ps: { installed: ran(1, 'Get-AppxPackage : The service cannot be started') } });
    expect(await main([WIN_DIR], w.io)).toBe(2);
    expect(w.out.join('\n')).toMatch(/cannot tell whether TN3270\.Probe is already installed/);
  });
});

describe('scratch under RUNNER_TEMP when set (AppData is the MSIX virtualization tree)', () => {
  it.each(['darwin', 'win32'] as const)('%s: RUNNER_TEMP is the parent; unset, the OS temp dir', async (platform) => {
    const world = platform === 'darwin' ? macWorld : winWorld;
    const set = world({ io: { env: { RUNNER_TEMP: platform === 'darwin' ? '/Users/runner/work/_temp' : 'D:\\a\\_temp' } } });
    expect(await main([platform === 'darwin' ? MAC_DIR : WIN_DIR], set.io)).toBe(0);
    expect(set.parents).toEqual([platform === 'darwin' ? '/Users/runner/work/_temp' : 'D:\\a\\_temp']);
    const unset = world();
    expect(await main([platform === 'darwin' ? MAC_DIR : WIN_DIR], unset.io)).toBe(0);
    expect(unset.parents).toEqual([undefined]);
  });
  it('nodeFs.mkdtemp makes the directory under the given parent', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storeprobe-parent-'));
    try {
      const d = nodeFs.mkdtemp('tn3270-store-probe-', parent);
      expect(d.startsWith(join(parent, 'tn3270-store-probe-'))).toBe(true);
      expect(existsSync(d)).toBe(true);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
});

describe('the confinement must HOLD, the reaps must be re-listed, the success must be counted', () => {
  it('mac: a launch that printed sandbox=<id> and then crashed (variant C, run 43115293433) FAILs', async () => {
    const w = macWorld({ launched: { stdout: fx('probe-mac-crashed-variant-c.txt'), held: false } });
    expect(await main([MAC_DIR], w.io)).toBe(1);
    expect(fails(w.out)).toEqual([expect.stringMatching(/^FAIL mac-sandbox: the app did not hold after its probe line: it exited within 5 s without showing the Connect dialog/)]);
    expect(w.events.some((e) => e.startsWith('check '))).toBe(false);
  });
  it('win: a launch that did not hold FAILs', async () => {
    const w = winWorld({ launched: { held: false } });
    expect(await main([WIN_DIR], w.io)).toBe(1);
    expect(fails(w.out).join('\n')).toMatch(/did not hold/);
  });
  it('mac: a process of ours still listed after kill -9 is a cleanup FAIL', async () => {
    const w = macWorld({ answers: { kill: ran(1, 'kill: 101: Operation not permitted') } });
    expect(await main([MAC_DIR], w.io)).toBe(1);
    expect(fails(w.out)).toEqual(['FAIL mac-sandbox: cleanup processes: still running after kill -9: 101 103']);
  }, 10_000);
  it('win: the reap script failing (its re-list threw) is a cleanup FAIL, and the uninstall still runs', async () => {
    const w = winWorld({ ps: { reap: ran(1, 'still running after Stop-Process: 828') } });
    expect(await main([WIN_DIR], w.io)).toBe(1);
    expect(fails(w.out)).toEqual(['FAIL win-msix: cleanup processes: exit 1: still running after Stop-Process: 828']);
    at(w.events, 'run Remove-AppxPackage');
  });
  it('win: a pfx or cer still there after removal is a cleanup FAIL', async () => {
    const w = winWorld({ keeps: [`${WIN_WORK}\\probe.pfx`] });
    expect(await main([WIN_DIR], w.io)).toBe(1);
    expect(fails(w.out)).toEqual([`FAIL win-msix: cleanup probe.pfx: ${WIN_WORK}\\probe.pfx still exists`]);
  });
  it('win: a certificate removal that fails its re-check is a cleanup FAIL', async () => {
    const w = winWorld({ ps: { 'cert-remove TrustedPeople': ran(1, `still there: Cert:\\LocalMachine\\TrustedPeople\\${THUMB}`) } });
    expect(await main([WIN_DIR], w.io)).toBe(1);
    expect(fails(w.out)).toEqual([`FAIL win-msix: cleanup certificate Cert:\\LocalMachine\\TrustedPeople: exit 1: still there: Cert:\\LocalMachine\\TrustedPeople\\${THUMB}`]);
  });
  it.each(['darwin', 'win32'] as const)('%s: an empty check list is exit 1: every required ok must be printed', async (platform) => {
    const w = platform === 'darwin' ? macWorld({ io: { checks: [] } }) : winWorld({ io: { checks: [] } });
    expect(await main([platform === 'darwin' ? MAC_DIR : WIN_DIR], w.io)).toBe(1);
    expect(fails(w.out)).toEqual([
      expect.stringMatching(/never shown to pass: replays a trace and draws the synthetic-ispf golden$/),
      expect.stringMatching(/never shown to pass: with no host, opens the Connect dialog and connects$/),
    ]);
    expect(w.out).toContain(`${platform === 'darwin' ? 'mac-sandbox: 2 of 4' : 'win-msix: 1 of 3'} required ok lines`);
  });
});

describe('the failure branches', () => {
  it('mac: plutil, ditto and the ElectronTeamID read-back failing each FAIL, and nothing is launched', async () => {
    const cases: [Record<string, Ran>, RegExp][] = [
      [{ plutil: ran(1, 'entitlements.mas.plist: Encountered unknown tag') }, /plutil -lint .*entitlements\.mas\.plist failed \(exit 1\): .*unknown tag/],
      [{ ditto: ran(1, 'ditto: No space left on device') }, /ditto \/a\/mas-universal\/TN3270\.app failed \(exit 1\): ditto: No space left on device/],
      [{ 'PlistBuddy Print': ok('ZZZZZ99999\n') }, /ElectronTeamID reads back as ZZZZZ99999, not H68TN685J4/],
    ];
    for (const [answers, why] of cases) {
      const w = macWorld({ answers });
      expect(await main([MAC_DIR], w.io)).toBe(1);
      expect(fails(w.out).join('\n')).toMatch(why);
      expect(w.events).not.toContain('launch');
    }
  });
  it('win: signtool failing is exit 1 and installs nothing; the cleanup still runs', async () => {
    const w = winWorld({ signtool: ran(1, 'SignTool Error: A required function is not present.') });
    expect(await main([WIN_DIR], w.io)).toBe(1);
    expect(fails(w.out)).toEqual(['FAIL win-msix: signtool sign failed (exit 1): SignTool Error: A required function is not present.']);
    expect(w.events).not.toContain('run Add-AppxPackage');
    for (const e of ['run cert-remove My', 'run cert-remove TrustedPeople']) at(w.events, e);
  });
  it('win: the alias query exiting non-zero is exit 2, even when it printed an alias line first', async () => {
    const w = winWorld({ ps: { alias: ran(1, `alias=${ALIAS}\nGet-Command : later error`) } });
    expect(await main([WIN_DIR], w.io)).toBe(2);
    expect(w.events).not.toContain('launch');
  });
  it('win: a setup failure before the certificate step removes no certificate (none was made)', async () => {
    let n = 0;
    const w = winWorld({ io: { env: { CI: 'true' } }, ps: {
      installed: () => ok(n++ === 0 ? 'installed=TN3270.Probe_0.1.3.0_x64__5j71tdef09jdy\n' : ''),
      'Remove-AppxPackage': ran(1, 'Remove-AppxPackage : Access denied'),
    } });
    expect(await main([WIN_DIR], w.io)).toBe(2);
    expect(w.out.join('\n')).toMatch(/could not remove the stale TN3270\.Probe_0\.1\.3\.0_x64__5j71tdef09jdy \(exit 1\): Remove-AppxPackage : Access denied/);
    expect(w.events.filter((e) => e.startsWith('run cert'))).toEqual([]);
    expect(fails(w.out)).toEqual([]);
  });
  it('win: the alias query itself failing is exit 2', async () => {
    const w = winWorld({ ps: { alias: ran(1, 'Get-Command : broken') } });
    expect(await main([WIN_DIR], w.io)).toBe(2);
    expect(w.out.join('\n')).toMatch(/not on PATH after Add-AppxPackage \(exit 1\): Get-Command : broken/);
  });
  it('win: the pid-to-package query failing, or reporting an exited pid, FAILs the confinement', async () => {
    for (const [answer, why] of [[ran(1, 'Add-Type : compiler error'), /package is query failed \(exit 1\): Add-Type : compiler error/], [ok('OpenProcess failed, error 87\n'), /package is OpenProcess failed, error 87/]] as const) {
      const w = winWorld({ ps: { GetPackageFullName: answer } });
      expect(await main([WIN_DIR], w.io)).toBe(1);
      expect(fails(w.out).join('\n')).toMatch(why);
    }
  });
  it('win: whileRunning never called (the app exited first) leaves the identity unmeasured: FAIL', async () => {
    const w = winWorld({ io: { launch: async () => ({ stdout: `${WIN_LINE}\n`, during: null, held: true, survivors: [] }) } });
    expect(await main([WIN_DIR], w.io)).toBe(1);
    expect(fails(w.out).join('\n')).toMatch(/package full name was not measured/);
  });
});

describe('launchForProbe holds, and whileRunning only sees a live process', () => {
  const withApp = async (src: string, fn: (route: { exe: string; prefix: string[]; env: Record<string, string>; installDir: string; probe: boolean }, tmp: string) => Promise<void>) => {
    const saved = process.env.DISPLAY;
    process.env.DISPLAY = saved ?? ':fake';
    const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'storeprobe-')));
    try {
      const app = join(tmp, 'fake-app.cjs');
      writeFileSync(app, src);
      await fn({ exe: process.execPath, prefix: [app], env: {}, installDir: tmp, probe: true }, tmp);
    } finally {
      if (saved === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = saved;
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  };
  it('a probe line and then an exit (variant C\'s shape) is held=false', async () => {
    await withApp("process.stdout.write('probe: sandbox=fake.id windowsStore=false\\n'); setTimeout(() => process.exit(133), 300);", async (route, tmp) => {
      const l = await launchForProbe(route, [], { work: tmp, stayMs: 3_000 });
      expect(l.stdout).toContain('probe: sandbox=fake.id');
      expect(l.held).toBe(false);
    });
  }, 60_000);
  it('the Connect dialog line holds at once; staying up past stayMs holds too', async () => {
    await withApp("process.stdout.write('probe: sandbox=fake.id windowsStore=false\\nconnect: dialog shown\\n'); setInterval(() => {}, 1000);", async (route, tmp) => {
      const t0 = Date.now();
      const l = await launchForProbe(route, [], { work: tmp, stayMs: 30_000 });
      expect(l.held).toBe(true);
      expect(Date.now() - t0).toBeLessThan(20_000);
      expect(typeof l.pid).toBe('number');
    });
    await withApp("process.stdout.write('probe: sandbox=fake.id windowsStore=false\\n'); setInterval(() => {}, 1000);", async (route, tmp) => {
      expect((await launchForProbe(route, [], { work: tmp, stayMs: 500 })).held).toBe(true);
    });
  }, 60_000);
  it('an app that exits without a probe line: whileRunning is never called on the dead pid', async () => {
    await withApp('process.exit(0);', async (route, tmp) => {
      let called = false;
      const l = await launchForProbe(route, [], { work: tmp, whileRunning: () => { called = true; return 'x'; } });
      expect(called).toBe(false);
      expect(l.during).toBeNull();
      expect(l.held).toBe(false);
    });
  }, 60_000);
  it('STAY_MS is 5 s', () => { expect(STAY_MS).toBe(5_000); });
});
