import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCodesignDisplay, judgeMacApp, parseAuthenticode, judgeWinFile, main, runCommand, spawnOptions, type Ran,
} from '../../../scripts/verify-signatures.mjs';

const fx = (n: string) => readFileSync(fileURLToPath(new URL(`./fixtures/signatures/${n}`, import.meta.url)), 'utf8');
/** `text` is stdout+stderr; by default it is all stdout. */
const ok = (text = '', stdout = text): Ran => ({ status: 0, stdout, text });
const no = (text = '', stdout = text): Ran => ({ status: 1, stdout, text });
const SIGNED_MAC = () => ({
  verify: ok(), display: ok(fx('codesign-dv-signed.txt')), spctl: ok(fx('spctl-notarized.txt')), stapler: ok('The validate action worked!'),
});
const UNSIGNED_MAC = () => ({
  verify: no('code has no resources but signature indicates they must be present'),
  display: ok(fx('codesign-dv-adhoc.txt')), spctl: no(fx('spctl-rejected.txt')), stapler: no('/scratch/zip/TN3270.app does not have a ticket stapled to it.'),
});

describe('parseCodesignDisplay (provisional fixtures)', () => {
  it('reads the authority chain, team and runtime flag of a Developer ID signature', () => {
    expect(parseCodesignDisplay(fx('codesign-dv-signed.txt'))).toEqual({
      authorities: ['Developer ID Application: Adam Thornton (ABCDE12345)', 'Developer ID Certification Authority', 'Apple Root CA'],
      teamId: 'ABCDE12345', runtime: true, adhoc: false,
    });
  });
  it('reads an ad-hoc signature as no authorities, no team, adhoc', () => {
    expect(parseCodesignDisplay(fx('codesign-dv-adhoc.txt'))).toEqual({ authorities: [], teamId: undefined, runtime: false, adhoc: true });
  });
});

describe('judgeMacApp (provisional fixtures)', () => {
  it('passes a signed, notarized, stapled app with --expect signed', () => {
    expect(judgeMacApp(SIGNED_MAC(), 'signed', 'ABCDE12345')).toEqual([]);
  });
  it.each([
    ['verify', { verify: no('a sealed resource is missing or invalid') }, /codesign --verify/],
    ['team', {}, /team ZZZZZ99999/],
    ['runtime', { display: ok(fx('codesign-dv-signed.txt').replace('(runtime)', '(none)')) }, /hardened runtime/],
    ['spctl', { spctl: no(fx('spctl-rejected.txt')) }, /spctl/],
    ['notarized source', { spctl: ok(fx('spctl-notarized.txt').replace('Notarized ', '')) }, /Notarized Developer ID/],
    ['stapler', { stapler: no('/scratch/zip/TN3270.app does not have a ticket stapled to it.') }, /stapler/],
  ])('fails --expect signed on a bad %s', (_n, patch, msg) => {
    const team = _n === 'team' ? 'ZZZZZ99999' : 'ABCDE12345';
    const problems = judgeMacApp({ ...SIGNED_MAC(), ...patch }, 'signed', team);
    expect(problems.join('\n')).toMatch(msg);
  });
  it('passes an ad-hoc app with --expect unsigned, and fails a Developer ID one', () => {
    expect(judgeMacApp(UNSIGNED_MAC(), 'unsigned', undefined)).toEqual([]);
    expect(judgeMacApp(SIGNED_MAC(), 'unsigned', undefined).join('\n')).toMatch(/Developer ID Application: Adam Thornton/);
  });
  it('refuses --expect signed without a team to check against', () => {
    expect(judgeMacApp(SIGNED_MAC(), 'signed', undefined).join('\n')).toMatch(/APPLE_TEAM_ID/);
  });
  it('--expect signed needs the team in BOTH the leaf authority and TeamIdentifier', () => {
    const leafOther = fx('codesign-dv-signed.txt').replace('Adam Thornton (ABCDE12345)', 'Adam Thornton (ZZZZZ99999)');
    expect(judgeMacApp({ ...SIGNED_MAC(), display: ok(leafOther) }, 'signed', 'ABCDE12345').join('\n')).toMatch(/\(ZZZZZ99999\), team ABCDE12345; expected team ABCDE12345/);
    const teamOther = fx('codesign-dv-signed.txt').replace('TeamIdentifier=ABCDE12345', 'TeamIdentifier=ZZZZZ99999');
    expect(judgeMacApp({ ...SIGNED_MAC(), display: ok(teamOther) }, 'signed', 'ABCDE12345').join('\n')).toMatch(/\(ABCDE12345\), team ZZZZZ99999; expected team ABCDE12345/);
  });
  it('--expect signed: a FAIL from spctl says when Gatekeeper is disabled', () => {
    const off = ok('/private/tmp/x/TN3270.app: accepted\noverride=security disabled');
    expect(judgeMacApp({ ...SIGNED_MAC(), spctl: off }, 'signed', 'ABCDE12345').join('\n')).toMatch(/Gatekeeper assessments are DISABLED.*override=security disabled/);
  });
});

describe('judgeMacApp --expect unsigned: only recognised shapes pass (provisional fixtures)', () => {
  it('passes "code object is not signed at all" from a failing codesign -dv', () => {
    const r = { ...UNSIGNED_MAC(), display: no('/private/tmp/x/TN3270.app: code object is not signed at all') };
    expect(judgeMacApp(r, 'unsigned', undefined)).toEqual([]);
  });
  it.each([
    ['codesign -dv failing with something else', { display: no('/private/tmp/x/TN3270.app: bundle format unrecognized, invalid, or unsuitable') }, /unrecognised codesign -dv answer.*codesign -dv exit 1: \/private\/tmp\/x\/TN3270\.app: bundle format unrecognized/],
    ['"not signed at all" with exit 0', { display: ok('code object is not signed at all') }, /unrecognised codesign -dv/],
    ['ad-hoc text with a non-zero exit', { display: no(fx('codesign-dv-adhoc.txt')) }, /unrecognised codesign -dv/],
    ['exit 0 and no ad-hoc flag', { display: ok(fx('codesign-dv-adhoc.txt').replace('(adhoc,linker-signed)', '(linker-signed)').replace('Signature=adhoc', 'Signature size=1')) }, /unrecognised codesign -dv/],
    ['ad-hoc with a team', { display: ok(fx('codesign-dv-adhoc.txt').replace('TeamIdentifier=not set', 'TeamIdentifier=ABCDE12345')) }, /unrecognised codesign -dv/],
    ['ad-hoc with an authority', { display: ok(`${fx('codesign-dv-adhoc.txt')}Authority=Some Other CA\n`) }, /unrecognised codesign -dv/],
    ['spctl exiting 0', { spctl: ok(fx('spctl-rejected.txt')) }, /unrecognised spctl answer/],
    ['spctl failing without ": rejected"', { spctl: no('xcrun: error: invalid active developer path') }, /unrecognised spctl answer.*spctl exit 1: xcrun: error/],
    ['spctl accepting with Gatekeeper off', { spctl: ok('/private/tmp/x/TN3270.app: accepted\noverride=security disabled') }, /unrecognised spctl answer.*Gatekeeper assessments are DISABLED/],
    ['stapler exiting 0', { stapler: ok('The validate action worked!') }, /unrecognised xcrun stapler/],
    ['stapler saying "no ticket" with exit 0', { stapler: ok('/scratch/zip/TN3270.app does not have a ticket stapled to it.') }, /unrecognised xcrun stapler.*exit 0/],
    ['stapler failing with no output', { stapler: no('') }, /unrecognised xcrun stapler.*xcrun stapler exit 1: \(no output\)/],
    ['stapler killed by a signal', { stapler: no('[killed by SIGSEGV]\n') }, /unrecognised xcrun stapler.*killed by SIGSEGV/],
    ['stapler failing with another error', { stapler: { status: 70, stdout: '', text: 'Operation not permitted' } }, /unrecognised xcrun stapler.*exit 70: Operation not permitted/],
    ['stapler failing as xcrun itself', { stapler: no('xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)') }, /unrecognised xcrun stapler.*xcrun: error/],
  ])('FAILs %s', (_n, patch, msg) => {
    expect(judgeMacApp({ ...UNSIGNED_MAC(), ...patch }, 'unsigned', undefined).join('\n')).toMatch(msg);
  });
});

describe('parseAuthenticode / judgeWinFile (provisional fixtures)', () => {
  it('parses status and subject', () => {
    expect(parseAuthenticode(fx('authenticode-valid.json'))).toEqual({
      status: 'Valid', subject: 'CN=Adam Thornton, O=Adam Thornton, L=Somewhere, S=Arizona, C=US',
    });
  });
  it('signed: Valid AND CN equal to the publisher; a CN that merely contains it is refused', () => {
    expect(judgeWinFile(parseAuthenticode(fx('authenticode-valid.json')), 'signed', 'Adam Thornton')).toEqual([]);
    expect(judgeWinFile(parseAuthenticode(fx('authenticode-valid.json')), 'signed', 'Adam').join('\n')).toMatch(/expected CN=Adam$/m);
    expect(judgeWinFile({ status: 'HashMismatch', subject: 'CN=Adam Thornton' }, 'signed', 'Adam Thornton').join('\n')).toMatch(/HashMismatch/);
    expect(judgeWinFile(parseAuthenticode(fx('authenticode-valid.json')), 'signed', undefined).join('\n')).toMatch(/AZURE_SIGNING_PUBLISHER/);
  });
  it('unsigned: only NotSigned passes; Valid and every other status fail', () => {
    expect(judgeWinFile(parseAuthenticode(fx('authenticode-notsigned.json')), 'unsigned', undefined)).toEqual([]);
    for (const status of ['HashMismatch', 'UnknownError', 'NotSupportedFileFormat', 'NotTrusted']) {
      expect(judgeWinFile({ status, subject: '' }, 'unsigned', undefined).join('\n'), status).toMatch(new RegExp(`status ${status}, not NotSigned`));
    }
    expect(judgeWinFile(parseAuthenticode(fx('authenticode-valid.json')), 'unsigned', undefined).join('\n')).toMatch(/Valid/);
  });
  it('refuses output that is not the projection', () => {
    expect(() => parseAuthenticode('Get-AuthenticodeSignature: not found')).toThrow(/not an Authenticode projection/);
    expect(() => parseAuthenticode('{"Status":"Valid"}')).toThrow(/not an Authenticode projection/);
  });
});

/** A fake `run` that answers by command name and records every call. */
function fakeRun(answers: Record<string, Ran | ((args: string[]) => Ran)>) {
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const key = cmd === 'codesign' ? `codesign ${args[0]}` : cmd === 'xcrun' ? 'stapler' : cmd.endsWith('.exe') ? 'exe' : cmd;
    const a = answers[key];
    if (a === undefined) return ok();
    return typeof a === 'function' ? a(args) : a;
  };
  return { run, calls };
}
/** What an ad-hoc-signed, unnotarized app answers (provisional fixtures). */
const UNSIGNED_ANSWERS = () => ({
  'codesign -dv': ok(fx('codesign-dv-adhoc.txt')), spctl: no(fx('spctl-rejected.txt')), 'codesign --verify': no('invalid'), stapler: no('/scratch/zip/TN3270.app does not have a ticket stapled to it.'),
});
const MAC_FILES = ['TN3270-0.1.5-mac-universal.dmg', 'TN3270-0.1.5-mac-universal.zip', 'TN3270-0.1.5-mac-universal.dmg.blockmap'];
/** The path inside a pwsh call's `-LiteralPath '...'`, with `''` undoubled. */
const literalPath = (c: string[]) => /LiteralPath '((?:[^']|'')*)'/.exec(c.at(-1)!)?.[1]?.replace(/''/g, "'");

describe('main', () => {
  const base = (over: Partial<Parameters<typeof main>[1]> = {}) => {
    const out: string[] = [];
    return {
      out,
      io: {
        env: {}, run: fakeRun({}).run, log: (l: string) => out.push(l), platform: 'darwin',
        list: () => MAC_FILES, scratch: () => '/scratch', exists: () => true, ...over,
      },
    };
  };

  it('is a usage error without --expect signed|unsigned, and on linux', () => {
    expect(main([], base().io)).toBe(2);
    expect(main(['--expect', 'maybe'], base().io)).toBe(2);
    expect(main(['--expect', 'unsigned'], base({ platform: 'linux' }).io)).toBe(2);
  });

  it('macOS signed: checks the app in BOTH the zip and the dmg, and always detaches', () => {
    const f = fakeRun({
      'codesign -dv': ok(fx('codesign-dv-signed.txt')), spctl: ok(fx('spctl-notarized.txt')),
    });
    const { io, out } = base({ run: f.run, env: { APPLE_TEAM_ID: 'ABCDE12345' } });
    expect(main(['--expect', 'signed', '/a'], io)).toBe(0);
    const apps = f.calls.filter((c) => c[0] === 'codesign' && c[1] === '--verify').map((c) => c.at(-1));
    expect(apps).toEqual(['/scratch/zip/TN3270.app', '/scratch/dmg/TN3270.app']);
    expect(f.calls).toContainEqual(['ditto', '-x', '-k', '/a/TN3270-0.1.5-mac-universal.zip', '/scratch/zip']);
    expect(f.calls).toContainEqual(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', '/scratch/dmg', '/a/TN3270-0.1.5-mac-universal.dmg']);
    expect(f.calls.filter((c) => c[0] === 'hdiutil' && c[1] === 'detach')).toEqual([['hdiutil', 'detach', '/scratch/dmg']]);
    expect(out.filter((l) => l.startsWith('ok '))).toEqual(['ok TN3270-0.1.5-mac-universal.zip: signed', 'ok TN3270-0.1.5-mac-universal.dmg: signed']);
  });

  it('macOS: detaches the dmg even when a check throws', () => {
    const f = fakeRun({ spctl: () => { throw new Error('boom'); } });
    const { io } = base({ run: f.run, env: { APPLE_TEAM_ID: 'ABCDE12345' } });
    expect(() => main(['--expect', 'signed', '/a'], io)).toThrow(/boom/);
    expect(f.calls.some((c) => c[0] === 'hdiutil' && c[1] === 'detach')).toBe(true);
  });

  it('macOS: a failed detach is retried with -force', () => {
    const f = fakeRun({ hdiutil: (args) => (args[0] === 'detach' && args[1] !== '-force' ? no('resource busy') : ok()) });
    const { io } = base({ run: f.run });
    main(['--expect', 'unsigned', '/a'], io);
    expect(f.calls.filter((c) => c[0] === 'hdiutil' && c[1] === 'detach')).toEqual([['hdiutil', 'detach', '/scratch/dmg'], ['hdiutil', 'detach', '-force', '/scratch/dmg']]);
  });

  it('macOS: a detach that throws is logged and does not mask the error that got there', () => {
    const f = fakeRun({
      spctl: () => { throw new Error('spctl-exploded'); },
      hdiutil: (args) => { if (args[0] === 'detach') throw new Error('hdiutil-vanished'); return ok(); },
    });
    const { io, out } = base({ run: f.run });
    expect(() => main(['--expect', 'unsigned', '/a'], io)).toThrow(/spctl-exploded/);
    expect(out.join('\n')).toMatch(/hdiutil detach \/scratch\/dmg threw: hdiutil-vanished/);
  });

  it('macOS: a non-zero ditto is a FAIL for the zip, even with an app left behind', () => {
    const f = fakeRun({ ...UNSIGNED_ANSWERS(), ditto: no('ditto: Couldn\'t read PKZip signature') });
    const { io, out } = base({ run: f.run });
    expect(main(['--expect', 'unsigned', '/a'], io)).toBe(1);
    expect(out).toContain("FAIL TN3270-0.1.5-mac-universal.zip: ditto -x -k failed (exit 1): ditto: Couldn't read PKZip signature");
    expect(out).toContain('ok TN3270-0.1.5-mac-universal.dmg: unsigned');
  });

  it('VERIFY_SIGNATURES_ECHO=1 on macOS also logs spctl --status once, and never judges it', () => {
    const f = fakeRun({ ...UNSIGNED_ANSWERS(), spctl: (args) => (args[0] === '--status' ? ok('assessments disabled') : no(fx('spctl-rejected.txt'))) });
    const { io, out } = base({ run: f.run, env: { VERIFY_SIGNATURES_ECHO: '1' } });
    expect(main(['--expect', 'unsigned', '/a'], io)).toBe(0);
    expect(f.calls.filter((c) => c[0] === 'spctl' && c[1] === '--status')).toHaveLength(1);
    expect(out.join('\n')).toMatch(/\$ spctl --status\nassessments disabled/);
    const quiet = fakeRun(UNSIGNED_ANSWERS());
    main(['--expect', 'unsigned', '/a'], base({ run: quiet.run }).io);
    expect(quiet.calls.some((c) => c[1] === '--status')).toBe(false);
  });

  it("macOS unsigned: the review's case -- broken tools everywhere -- is exit 1, not ok", () => {
    const broken = no('xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)');
    const f = fakeRun({ 'codesign -dv': no('TN3270.app: bundle format unrecognized, invalid, or unsuitable'), 'codesign --verify': broken, spctl: broken, stapler: broken });
    const { io, out } = base({ run: f.run });
    expect(main(['--expect', 'unsigned', '/a'], io)).toBe(1);
    expect(out.some((l) => l.startsWith('ok '))).toBe(false);
  });

  it('macOS unsigned: an ad-hoc build passes; the same build with --expect signed fails (exit 1)', () => {
    const answers = UNSIGNED_ANSWERS();
    expect(main(['--expect', 'unsigned', '/a'], base({ run: fakeRun(answers).run }).io)).toBe(0);
    const { io, out } = base({ run: fakeRun(answers).run, env: { APPLE_TEAM_ID: 'ABCDE12345' } });
    expect(main(['--expect', 'signed', '/a'], io)).toBe(1);
    expect(out.join('\n')).toMatch(/FAIL TN3270-0\.1\.5-mac-universal\.zip:/);
  });

  it('macOS: a zip that unpacks without TN3270.app, or a dmg that will not mount, is a FAIL even --expect unsigned', () => {
    const { io, out } = base({ exists: (p: string) => !p.startsWith('/scratch/zip') });
    expect(main(['--expect', 'unsigned', '/a'], io)).toBe(1);
    expect(out.join('\n')).toMatch(/FAIL TN3270-0\.1\.5-mac-universal\.zip: .*TN3270\.app/);
    const f = fakeRun({ hdiutil: (args) => (args[0] === 'attach' ? no('attach failed: no mountable file systems') : ok()) });
    const b = base({ run: f.run });
    expect(main(['--expect', 'unsigned', '/a'], b.io)).toBe(1);
    expect(b.out.join('\n')).toMatch(/FAIL TN3270-0\.1\.5-mac-universal\.dmg: .*no mountable file systems/);
  });

  it('a missing or duplicated artifact is exit 2, naming what IS there', () => {
    const { io, out } = base({ list: () => ['TN3270-0.1.5-mac-universal.dmg'] });
    expect(main(['--expect', 'unsigned', '/a'], io)).toBe(2);
    expect(out.join('\n')).toMatch(/mac-universal\.zip.*TN3270-0\.1\.5-mac-universal\.dmg/s);
    const dup = base({ list: () => [...MAC_FILES, 'TN3270-0.1.6-mac-universal.zip'] });
    expect(main(['--expect', 'unsigned', '/a'], dup.io)).toBe(2);
    expect(dup.out.join('\n')).toMatch(/TN3270-0\.1\.5-mac-universal\.zip.*TN3270-0\.1\.6-mac-universal\.zip/s);
    const win = base({ platform: 'win32', list: () => [] });
    expect(main(['--expect', 'unsigned', 'C:\\a'], win.io)).toBe(2);
    expect(win.out.join('\n')).toMatch(/win-x64\.exe/);
  });

  it('Windows signed: checks the installer, then the installed app and uninstaller', () => {
    const valid = ok(fx('authenticode-valid.json'));
    const f = fakeRun({ pwsh: valid });
    const { io, out } = base({ platform: 'win32', run: f.run, list: () => ['TN3270-0.1.5-win-x64.exe'], env: { AZURE_SIGNING_PUBLISHER: 'Adam Thornton' } });
    expect(main(['--expect', 'signed', 'C:\\a'], io)).toBe(0);
    const checked = f.calls.filter((c) => c[0] === 'pwsh').map(literalPath);
    expect(checked.map((p) => p!.split(/[\\/]/).at(-1))).toEqual(['TN3270-0.1.5-win-x64.exe', 'TN3270.exe', 'Uninstall TN3270.exe']);
    expect(out.filter((l) => l.startsWith('ok '))).toHaveLength(3);
  });

  it('Windows: installs silently, /D= last and verbatim, and uninstalls afterwards', () => {
    const calls: { cmd: string; args: string[]; verbatim: boolean | undefined }[] = [];
    const run = (cmd: string, args: string[], opts?: { verbatim?: boolean }) => {
      calls.push({ cmd, args, verbatim: opts?.verbatim });
      return cmd === 'pwsh' ? ok(fx('authenticode-notsigned.json')) : ok();
    };
    const { io } = base({ platform: 'win32', run, list: () => ['TN3270-0.1.5-win-x64.exe'] });
    expect(main(['--expect', 'unsigned', '/a'], io)).toBe(0);
    const installs = calls.filter((c) => c.cmd.endsWith('win-x64.exe'));
    expect(installs).toEqual([{ cmd: '/a/TN3270-0.1.5-win-x64.exe', args: ['/S', '/D=/scratch/install'], verbatim: true }]);
    // `_?=` last and verbatim: NSIS then runs in place and waits (installUtil.nsh does the same).
    expect(calls.at(-1)).toEqual({ cmd: '/scratch/install/Uninstall TN3270.exe', args: ['/S', '_?=/scratch/install'], verbatim: true });
  });

  it("Windows: a ' in a path is doubled inside pwsh's single quotes", () => {
    const f = fakeRun({ pwsh: ok(fx('authenticode-notsigned.json')) });
    const { io } = base({ platform: 'win32', run: f.run, scratch: () => "/it's", list: () => ['TN3270-0.1.5-win-x64.exe'] });
    expect(main(['--expect', 'unsigned', '/a'], io)).toBe(0);
    const cmds = f.calls.filter((c) => c[0] === 'pwsh').map((c) => c.at(-1)!);
    expect(cmds[1]).toContain("-LiteralPath '/it''s/install/TN3270.exe'");
    expect(f.calls.filter((c) => c[0] === 'pwsh').map(literalPath)[1]).toBe("/it's/install/TN3270.exe");
  });

  it.each([
    ['output that is not the projection, exit 0', ok('Get-AuthenticodeSignature: Cannot find path'), /not an Authenticode projection: .*Cannot find path/],
    ['a failed pwsh, even with a projection on its output', no(fx('authenticode-notsigned.json')), /Get-AuthenticodeSignature failed \(exit 1\)/],
  ])('Windows: %s is a FAIL in BOTH modes, never "unsigned"', (_n, answer, msg) => {
    for (const mode of ['signed', 'unsigned']) {
      const f = fakeRun({ pwsh: answer });
      const { io, out } = base({ platform: 'win32', run: f.run, list: () => ['TN3270-0.1.5-win-x64.exe'], env: { AZURE_SIGNING_PUBLISHER: 'Adam Thornton' } });
      expect(main(['--expect', mode, '/a'], io), mode).toBe(1);
      const fails = out.filter((l) => l.startsWith('FAIL TN3270-0.1.5-win-x64.exe: '));
      expect(fails.join('\n'), mode).toMatch(msg);
    }
  });

  it('Windows: a missing installed TN3270.exe is a FAIL naming what was installed', () => {
    const f = fakeRun({ pwsh: ok(fx('authenticode-valid.json')) });
    const { io, out } = base({
      platform: 'win32', run: f.run, env: { AZURE_SIGNING_PUBLISHER: 'Adam Thornton' },
      list: (d: string) => (d.endsWith('install') ? ['Other.exe', 'resources.pak'] : ['TN3270-0.1.5-win-x64.exe']),
      exists: (p: string) => !p.endsWith('TN3270.exe') || p.endsWith('win-x64.exe'),
    });
    expect(main(['--expect', 'signed', 'C:\\a'], io)).toBe(1);
    expect(out).toContain('FAIL installed TN3270.exe: no /scratch/install/TN3270.exe; its .exe files are Other.exe');
  });

  it('Windows: the JSON is read from stdout alone, with progress records switched off', () => {
    const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1"><Obj S="progress" RefId="0"></Obj></Objs>';
    const json = fx('authenticode-valid.json');
    const f = fakeRun({ pwsh: ok(json + clixml, json) });
    const { io, out } = base({ platform: 'win32', run: f.run, list: () => ['TN3270-0.1.5-win-x64.exe'], env: { AZURE_SIGNING_PUBLISHER: 'Adam Thornton' } });
    expect(main(['--expect', 'signed', '/a'], io), out.join('\n')).toBe(0);
    for (const c of f.calls.filter((k) => k[0] === 'pwsh')) expect(c.at(-1)).toMatch(/^\$ProgressPreference='SilentlyContinue'; Get-AuthenticodeSignature /);
  });

  it('Windows: an install that made no directory FAILs both installed files', () => {
    const f = fakeRun({ pwsh: ok(fx('authenticode-notsigned.json')) });
    const { io, out } = base({
      platform: 'win32', run: f.run,
      list: (d: string) => { if (d.endsWith('install')) throw new Error('ENOENT: no such file or directory'); return ['TN3270-0.1.5-win-x64.exe']; },
      exists: (p: string) => !p.includes('install'),
    });
    expect(main(['--expect', 'unsigned', '/a'], io)).toBe(1);
    expect(out.filter((l) => l.startsWith('FAIL installed '))).toEqual([
      'FAIL installed TN3270.exe: no /scratch/install/TN3270.exe; its .exe files are (cannot list: ENOENT: no such file or directory)',
      'FAIL installed Uninstall TN3270.exe: no /scratch/install/Uninstall TN3270.exe; its .exe files are (cannot list: ENOENT: no such file or directory)',
    ]);
  });

  it('Windows: a failed silent install is a FAIL even --expect unsigned', () => {
    const f = fakeRun({ pwsh: ok(fx('authenticode-notsigned.json')), exe: no() });
    const { io, out } = base({ platform: 'win32', run: f.run, list: () => ['TN3270-0.1.5-win-x64.exe'] });
    expect(main(['--expect', 'unsigned', '/a'], io)).toBe(1);
    expect(out).toContain('ok TN3270-0.1.5-win-x64.exe: unsigned');
    expect(out).toContain('FAIL install: silent install of TN3270-0.1.5-win-x64.exe failed (exit 1): ');
    expect(out.some((l) => l.startsWith('FAIL TN3270-0.1.5-win-x64.exe'))).toBe(false);
  });

  it('VERIFY_SIGNATURES_ECHO=1 logs each command and its raw text (for capturing fixtures)', () => {
    const f = fakeRun({ 'codesign -dv': ok(fx('codesign-dv-adhoc.txt')), spctl: no('rejected-raw') });
    const { io, out } = base({ run: f.run, env: { VERIFY_SIGNATURES_ECHO: '1' } });
    main(['--expect', 'unsigned', '/a'], io);
    expect(out.join('\n')).toMatch(/\$ spctl -a -t exec -vv \/scratch\/zip\/TN3270\.app[\s\S]*rejected-raw/);
    const quiet = base({ run: f.run });
    main(['--expect', 'unsigned', '/a'], quiet.io);
    // (The unrecognised-spctl FAIL quotes the raw text; the echo's own lines are what must be absent.)
    expect(quiet.out.filter((l) => l.startsWith('$ ') || l.startsWith('rejected-raw'))).toEqual([]);
  });

  it('removes its own scratch directory, but not an injected one', () => {
    const f = fakeRun(UNSIGNED_ANSWERS());
    const { scratch: _injected, ...io } = base({ run: f.run }).io;
    expect(main(['--expect', 'unsigned', '/a'], io)).toBe(0);
    const zipDir = f.calls.find((c) => c[0] === 'ditto')!.at(-1)!;
    expect(zipDir).toMatch(/tn3270-sig-/);
    expect(existsSync(dirname(zipDir))).toBe(false);
  });
});

describe('runCommand', () => {
  it('returns the exit status with stdout and stderr together', () => {
    expect(runCommand('sh', ['-c', 'echo out; echo err >&2; exit 3'])).toEqual({ status: 3, stdout: 'out\n', text: 'out\nerr\n' });
  });
  it('says so in text when the command was killed by a signal', () => {
    expect(runCommand('sh', ['-c', 'echo before; kill -TERM $$'])).toEqual({ status: 1, stdout: 'before\n', text: 'before\n[killed by SIGTERM]\n' });
  });
  it('gives every command at most 10 minutes; verbatim adds package-smoke\'s two options', () => {
    expect(spawnOptions('x.exe')).toMatchObject({ timeout: 600_000, encoding: 'utf8' });
    expect(spawnOptions('x.exe')).not.toHaveProperty('windowsVerbatimArguments');
    expect(spawnOptions('C:\\a b\\x.exe', { verbatim: true })).toMatchObject({ timeout: 600_000, windowsVerbatimArguments: true, argv0: '"C:\\a b\\x.exe"' });
  });
  it('THROWS when the tool cannot start: a missing codesign is not an unsigned app', () => {
    expect(() => runCommand('tn3270-no-such-tool', ['--verify'])).toThrow(/tn3270-no-such-tool/);
  });
});
