import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCodesignDisplay, judgeMacApp, parseAuthenticode, judgeWinFile, main, runCommand, type Ran,
} from '../../../scripts/verify-signatures.mjs';

const fx = (n: string) => readFileSync(fileURLToPath(new URL(`./fixtures/signatures/${n}`, import.meta.url)), 'utf8');
const ok = (text = ''): Ran => ({ status: 0, text });
const no = (text = ''): Ran => ({ status: 1, text });
const SIGNED_MAC = () => ({
  verify: ok(), display: ok(fx('codesign-dv-signed.txt')), spctl: ok(fx('spctl-notarized.txt')), stapler: ok('The validate action worked!'),
});
const UNSIGNED_MAC = () => ({
  verify: no('code has no resources but signature indicates they must be present'),
  display: ok(fx('codesign-dv-adhoc.txt')), spctl: no(fx('spctl-rejected.txt')), stapler: no('does not have a ticket stapled to it'),
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
    ['stapler', { stapler: no('does not have a ticket stapled to it') }, /stapler/],
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
  it('unsigned: anything but Valid passes; Valid fails', () => {
    expect(judgeWinFile(parseAuthenticode(fx('authenticode-notsigned.json')), 'unsigned', undefined)).toEqual([]);
    expect(judgeWinFile({ status: 'HashMismatch', subject: '' }, 'unsigned', undefined)).toEqual([]);
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
    expect(f.calls.some((c) => c[0] === 'hdiutil' && c[1] === 'detach')).toBe(true);
    expect(out.filter((l) => l.startsWith('ok '))).toEqual(['ok TN3270-0.1.5-mac-universal.zip: signed', 'ok TN3270-0.1.5-mac-universal.dmg: signed']);
  });

  it('macOS: detaches the dmg even when a check throws', () => {
    const f = fakeRun({ spctl: () => { throw new Error('boom'); } });
    const { io } = base({ run: f.run, env: { APPLE_TEAM_ID: 'ABCDE12345' } });
    expect(() => main(['--expect', 'signed', '/a'], io)).toThrow(/boom/);
    expect(f.calls.some((c) => c[0] === 'hdiutil' && c[1] === 'detach')).toBe(true);
  });

  it('macOS unsigned: an ad-hoc build passes; the same build with --expect signed fails (exit 1)', () => {
    const answers = { 'codesign -dv': ok(fx('codesign-dv-adhoc.txt')), spctl: no(fx('spctl-rejected.txt')), 'codesign --verify': no('invalid'), stapler: no('no ticket') };
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
    expect(calls.at(-1)).toMatchObject({ cmd: '/scratch/install/Uninstall TN3270.exe', args: ['/S'] });
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
      list: (d: string) => (d.endsWith('install') ? ['Other.exe'] : ['TN3270-0.1.5-win-x64.exe']),
      exists: (p: string) => !p.endsWith('TN3270.exe') || p.endsWith('win-x64.exe'),
    });
    expect(main(['--expect', 'signed', 'C:\\a'], io)).toBe(1);
    expect(out.join('\n')).toMatch(/TN3270\.exe.*Other\.exe/s);
  });

  it('Windows: a failed silent install is a FAIL even --expect unsigned', () => {
    const f = fakeRun({ pwsh: ok(fx('authenticode-notsigned.json')), exe: no() });
    const { io, out } = base({ platform: 'win32', run: f.run, list: () => ['TN3270-0.1.5-win-x64.exe'] });
    expect(main(['--expect', 'unsigned', '/a'], io)).toBe(1);
    expect(out.join('\n')).toMatch(/FAIL TN3270-0\.1\.5-win-x64\.exe: silent install/);
  });

  it('VERIFY_SIGNATURES_ECHO=1 logs each command and its raw text (for capturing fixtures)', () => {
    const f = fakeRun({ 'codesign -dv': ok(fx('codesign-dv-adhoc.txt')), spctl: no('rejected-raw') });
    const { io, out } = base({ run: f.run, env: { VERIFY_SIGNATURES_ECHO: '1' } });
    main(['--expect', 'unsigned', '/a'], io);
    expect(out.join('\n')).toMatch(/\$ spctl -a -t exec -vv \/scratch\/zip\/TN3270\.app[\s\S]*rejected-raw/);
    const quiet = base({ run: f.run });
    main(['--expect', 'unsigned', '/a'], quiet.io);
    expect(quiet.out.join('\n')).not.toMatch(/rejected-raw|\$ /);
  });

  it('removes its own scratch directory, but not an injected one', () => {
    const f = fakeRun({});
    const { scratch: _injected, ...io } = base({ run: f.run }).io;
    expect(main(['--expect', 'unsigned', '/a'], io)).toBe(0);
    const zipDir = f.calls.find((c) => c[0] === 'ditto')!.at(-1)!;
    expect(zipDir).toMatch(/tn3270-sig-/);
    expect(existsSync(dirname(zipDir))).toBe(false);
  });
});

describe('runCommand', () => {
  it('returns the exit status with stdout and stderr together', () => {
    expect(runCommand('sh', ['-c', 'echo out; echo err >&2; exit 3'])).toEqual({ status: 3, text: 'out\nerr\n' });
  });
  it('THROWS when the tool cannot start: a missing codesign is not an unsigned app', () => {
    expect(() => runCommand('tn3270-no-such-tool', ['--verify'])).toThrow(/tn3270-no-such-tool/);
  });
});
