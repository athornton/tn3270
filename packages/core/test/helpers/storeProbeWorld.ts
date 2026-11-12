/**
 * Fake macOS and Windows worlds for store-probe's `main`: every command, file-system call,
 * launch and check is recorded in ONE `events` list, so a test can assert their order. The
 * answers are the spike's captures (fixtures/store-probe/), and each can be overridden.
 */
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Io, Launched, Ran } from '../../../../scripts/store-probe.mjs';
import type { Check, CheckResult, Route } from '../../../../scripts/package-checks.mjs';

/** A fixture's captured text, its `#` provenance header removed (the tools never print one). */
export const fx = (n: string) => readFileSync(fileURLToPath(new URL(`../fixtures/store-probe/${n}`, import.meta.url)), 'utf8')
  .split('\n').filter((l) => !l.startsWith('#')).join('\n');

export const ran = (status: number, text = '', stdout = text): Ran => ({ status, stdout, text });
export const ok = (text = '') => ran(0, text);

export const HOME = '/Users/runner';
export const CONTAINER = `${HOME}/Library/Containers/io.github.athornton.tn3270`;
export const MAC_DIR = '/a';
export const MAC_SRC = `${MAC_DIR}/mas-universal/TN3270.app`;
export const MAC_WORK = '/scratch/tn3270-store-probe-1';
export const MAC_APP = `${MAC_WORK}/TN3270.app`;
const FW = `${MAC_APP}/Contents/Frameworks`;
export const LOGIN_ITEMS = `${MAC_APP}/Contents/Library/LoginItems`;
export const LOGIN_HELPER = `${LOGIN_ITEMS}/TN3270 Login Helper.app`;
/** What `find` printed for round 4's MAS app (the nested list of run 43115293433), per query. */
export const MAC_FIND = {
  dylibs: [`${FW}/Electron Framework.framework/Versions/A/Libraries/libvk_swiftshader.dylib`, `${FW}/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib`],
  frameworks: [`${FW}/Electron Framework.framework`],
  helpers: ['TN3270 Helper (Renderer).app', 'TN3270 Helper.app', 'TN3270 Helper (GPU).app', 'TN3270 Helper (Plugin).app'].map((h) => `${FW}/${h}`),
  login: [`${LOGIN_HELPER}/Contents/MacOS/TN3270 Login Helper`],
};
export const SANDBOXED_LINE = 'probe: sandbox=io.github.athornton.tn3270 windowsStore=false';
export const WIN_LINE = 'probe: sandbox=none windowsStore=true';

export const WIN_DIR = 'C:\\a';
export const WIN_WORK = 'C:\\scratch\\tn3270-store-probe-1';
export const SDK = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
export const SIGNTOOL = `${SDK}\\10.0.26100.0\\x64\\signtool.exe`;
export const ALIAS = 'C:\\Users\\runneradmin\\AppData\\Local\\Microsoft\\WindowsApps\\tn3270-gui.exe';
export const INSTALL = 'C:\\Program Files\\WindowsApps\\TN3270.Probe_0.1.4.0_x64__5j71tdef09jdy';
export const THUMB = '4E7733D6F453C85023DF5488E7B8A9964885E700';
export const PW = 'not-a-real-password-0123';

/** The script of a `powershell -EncodedCommand <base64 UTF-16LE>` call. */
export const psScript = (call: string[]) => {
  expect(call.at(-2)).toBe('-EncodedCommand');
  return Buffer.from(call.at(-1)!, 'base64').toString('utf16le');
};

/** Which spike step a PowerShell script is, by what it runs. */
export function psKind(script: string): string {
  if (script.includes('New-SelfSignedCertificate')) return 'certificate';
  if (script.includes('"installed=$(')) return 'installed';
  if (script.includes('Add-AppxPackage -Path')) return 'Add-AppxPackage';
  if (script.includes('ConvertTo-Json')) return 'Get-AppxPackage';
  if (script.includes('Get-Command tn3270-gui.exe')) return 'alias';
  if (script.includes('GetPackageFullName')) return 'GetPackageFullName';
  if (script.includes('Win32_Process')) return 'reap';
  if (script.includes('Remove-AppxPackage')) return 'Remove-AppxPackage';
  if (script.includes('Remove-Item') && script.includes('CurrentUser\\My')) return 'cert-remove My';
  if (script.includes('Remove-Item') && script.includes('TrustedPeople')) return 'cert-remove TrustedPeople';
  return 'other';
}

type Answer = Ran | ((args: string[]) => Ran);
export interface World {
  io: Io;
  events: string[];
  out: string[];
  calls: string[][];
  routes: Route[];
  launchArgs: string[][];
  /** The `parent` each mkdtemp was given (undefined: the OS temp dir). */
  parents: (string | undefined)[];
}

/** Two checks named as package-checks' are, answering `probe` (a function of the check index). */
export function fakeChecks(events: string[], probe: (i: number) => string | null = () => SANDBOXED_LINE, note = ''): ReadonlyArray<readonly [string, Check]> {
  const mk = (i: number, name: string): Check => {
    const f = async (route: Route, work: string): Promise<CheckResult> => {
      events.push(`check ${name} ${work}`);
      route.stage?.(`${work}/launch-${i}`);
      return { note, probe: probe(i) };
    };
    Object.defineProperty(f, 'name', { value: name });
    return f;
  };
  return [['replays a trace and draws the synthetic-ispf golden', mk(0, 'drawsGolden')], ['with no host, opens the Connect dialog and connects', mk(1, 'dialogConnects')]];
}

export function macWorld(over: {
  answers?: Record<string, Answer>; launched?: Partial<Launched>; makesContainer?: boolean; io?: Partial<Io>;
  launch?: Io['launch']; containerBefore?: boolean; listings?: Record<string, string[]>;
} = {}): World {
  const events: string[] = []; const out: string[] = []; const calls: string[][] = []; const routes: Route[] = []; const launchArgs: string[][] = [];
  const parents: (string | undefined)[] = [];
  const paths = new Set<string>([MAC_SRC, MAC_APP, LOGIN_ITEMS, LOGIN_HELPER, ...(over.containerBefore ? [`${CONTAINER}/Data/old`] : [])]);
  let killed = false;
  const exists = (p: string) => [...paths].some((x) => x === p || x.startsWith(`${p}/`));
  const key = (cmd: string, args: string[]) => {
    if (cmd === 'find') return args.includes('*.dylib') ? 'find dylibs' : args.includes('*.framework') ? 'find frameworks' : args.includes('*.app') ? 'find helpers' : 'find login';
    if (cmd === 'codesign') return args[0] === '-d' ? 'codesign -d' : args[0] === '--verify' ? 'codesign --verify' : 'codesign sign';
    if (cmd === '/usr/libexec/PlistBuddy') return `PlistBuddy ${args[1]!.split(' ')[0]}`;
    return cmd;
  };
  const answers: Record<string, Answer> = {
    'find dylibs': ok(MAC_FIND.dylibs.join('\n') + '\n'),
    'find frameworks': ok(MAC_FIND.frameworks.join('\n') + '\n'),
    'find helpers': ok(MAC_FIND.helpers.join('\n') + '\n'),
    'find login': ok(MAC_FIND.login.join('\n') + '\n'),
    'codesign -d': ok(fx('codesign-d-entitlements-mas.txt')),
    'codesign --verify': ok(fx('codesign-verify-mas-valid.txt')),
    'codesign sign': (a) => ok(`${a.at(-1)}: replacing existing signature`),
    'PlistBuddy Print': ok('H68TN685J4\n'),
    plutil: (a) => ok(`${a.at(-1)}: OK`),
    // Ours (101, 103) until `kill` has run; a stranger (102) always.
    ps: () => ok(killed ? '  102 /usr/sbin/cfprefsd\n'
      : `  101 ${MAC_APP}/Contents/MacOS/TN3270\n  102 /usr/sbin/cfprefsd\n  103 /private${MAC_APP}/Contents/Frameworks/TN3270 Helper.app/Contents/MacOS/TN3270 Helper\n`),
    kill: () => { killed = true; return ok(); },
    ...over.answers,
  };
  const io: Io = {
    platform: 'darwin', env: {}, home: HOME, log: (l) => out.push(l),
    run: (cmd, args) => {
      calls.push([cmd, ...args]);
      const k = key(cmd, args);
      events.push(`run ${k}`);
      const a = answers[k];
      if (a === undefined) return ok();
      return typeof a === 'function' ? a(args) : a;
    },
    fs: {
      exists, list: (d) => over.listings?.[d] ?? (d === LOGIN_ITEMS ? ['TN3270 Login Helper.app'] : []),
      copy: (a, b) => { events.push(`copy ${a} ${b}`); paths.add(b); },
      rm: (p) => { events.push(`rm ${p}`); for (const x of [...paths]) if (x === p || x.startsWith(`${p}/`)) paths.delete(x); },
      mkdir: (d) => { paths.add(d); },
      mkdtemp: (prefix, parent) => { events.push(`mkdtemp ${prefix}`); parents.push(parent); paths.add(MAC_WORK); return MAC_WORK; },
      read: () => '', write: () => {},
    },
    launch: over.launch ?? (async (route, args) => {
      events.push('launch');
      routes.push(route); launchArgs.push(args);
      if (over.makesContainer !== false) paths.add(`${CONTAINER}/Data`);
      return { stdout: `${SANDBOXED_LINE}\nconnect: dialog shown\n`, during: null, held: true, pid: 4242, survivors: [], ...over.launched };
    }),
    checks: fakeChecks(events),
    now: (() => { let t = 0; return () => (t += 500); })(),
    ...over.io,
  };
  return { io, events, out, calls, routes, launchArgs, parents };
}

export function winWorld(over: {
  ps?: Record<string, Answer>; signtool?: Answer; launched?: Partial<Launched>; sdk?: string[]; files?: string[]; io?: Partial<Io>;
  /** Paths fs.rm leaves in place. */
  keeps?: string[];
} = {}): World {
  const events: string[] = []; const out: string[] = []; const calls: string[][] = []; const routes: Route[] = []; const launchArgs: string[][] = [];
  const parents: (string | undefined)[] = [];
  const paths = new Set<string>([SIGNTOOL, `${SDK}\\10.0.17763.0\\x64\\signtool.exe`]);
  const ps: Record<string, Answer> = {
    installed: ok(''),
    certificate: ok(`thumbprint=${THUMB}\n`),
    'Add-AppxPackage': ok('Add-AppxPackage: OK\n'),
    'Get-AppxPackage': ok(fx('get-appxpackage.json')),
    alias: ok(`alias=${ALIAS}\n`),
    GetPackageFullName: ok(fx('package-full-name.txt')),
    'Remove-AppxPackage': ok('removed TN3270.Probe_0.1.4.0_x64__5j71tdef09jdy\n'),
    'cert-remove My': ok('removed\n'),
    'cert-remove TrustedPeople': ok('removed\n'),
    ...over.ps,
  };
  const io: Io = {
    platform: 'win32', env: {}, home: 'C:\\Users\\runneradmin', log: (l) => out.push(l), secret: () => PW,
    run: (cmd, args) => {
      calls.push([cmd, ...args]);
      const k = cmd === 'powershell' ? psKind(psScript([cmd, ...args])) : cmd.endsWith('signtool.exe') ? 'signtool' : cmd;
      events.push(`run ${k}`);
      const a = k === 'signtool' ? (over.signtool ?? ok(fx('signtool-sign-sdk.txt'))) : ps[k];
      if (a === undefined) return ok();
      return typeof a === 'function' ? a(args) : a;
    },
    fs: {
      exists: (p) => paths.has(p),
      list: (d) => {
        if (d === WIN_DIR) return over.files ?? ['TN3270-0.1.4-win-x64.appx', 'TN3270-0.1.4-win-x64.exe'];
        if (d === SDK) return over.sdk ?? ['10.0.17763.0', '10.0.26100.0', '10.0.9999.0', 'arm64'];
        throw new Error(`ENOENT ${d}`);
      },
      copy: (a, b) => { events.push(`copy ${a} ${b}`); paths.add(b); },
      rm: (p) => { events.push(`rm ${p}`); if (!over.keeps?.includes(p)) paths.delete(p); },
      mkdir: (d) => { paths.add(d); },
      mkdtemp: (prefix, parent) => { events.push(`mkdtemp ${prefix}`); parents.push(parent); for (const f of ['probe.pfx', 'probe.cer']) paths.add(`${WIN_WORK}\\${f}`); return WIN_WORK; },
      read: () => '', write: () => {},
    },
    launch: async (route, args, opts) => {
      events.push('launch');
      routes.push(route); launchArgs.push(args);
      const during = opts.whileRunning ? opts.whileRunning(828) : null;
      return { stdout: `\n${WIN_LINE}\n`, during, held: true, pid: 828, survivors: [], ...over.launched };
    },
    checks: fakeChecks(events, () => WIN_LINE),
    now: (() => { let t = 0; return () => (t += 500); })(),
    ...over.io,
  };
  return { io, events, out, calls, routes, launchArgs, parents };
}
