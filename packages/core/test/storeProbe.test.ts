import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  BUNDLE_ID, IDENTITY_NAME, PUBLISHER, TEAM_ID, containerPath, judgeMacConfinement, judgeSignatureVerify, judgeWinConfinement,
  macRoute, parseAppxPackage, parseProbeLine, winRoute,
} from '../../../scripts/store-probe.mjs';

/** A fixture's captured text, its `#` provenance header removed (the tools never print one). */
const fx = (n: string) => readFileSync(fileURLToPath(new URL(`./fixtures/store-probe/${n}`, import.meta.url)), 'utf8')
  .split('\n').filter((l) => !l.startsWith('#')).join('\n');

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
