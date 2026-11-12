import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHECKS, GOLDEN, NO_SEAMS, TRACE, defaultStage, dialogConnects, drawsGolden, exitedWithin, probeSeen, routeDefaults, start, switches,
  type Route,
} from '../../../scripts/package-checks.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const bare: Route = { exe: 'x', prefix: [], env: {} };

describe('package-checks route defaults (package-smoke\'s behaviour)', () => {
  it('the default stage is the repository trace, and shot.png and user-data in the launch dir', () => {
    const dir = join(tmpdir(), 'launch-1');
    expect(defaultStage(dir)).toEqual({
      trace: join(repo, 'packages', 'fixtures', 'traces', 'synthetic-ispf-like.trace'),
      shot: join(dir, 'shot.png'),
      userData: join(dir, 'user-data'),
    });
    expect(existsSync(defaultStage(dir).trace)).toBe(true);
  });
  it('a route with no optional fields gets the default stage, no probe, and processDir = installDir', () => {
    expect(routeDefaults(bare)).toEqual({ stage: defaultStage, probe: false, processDir: undefined });
    expect(routeDefaults({ ...bare, installDir: 'C:\\x\\install dir' }).processDir).toBe('C:\\x\\install dir');
  });
  it('a route\'s own fields win', () => {
    const stage = (d: string) => ({ trace: 't', shot: join(d, 's'), userData: 'u' });
    expect(routeDefaults({ ...bare, installDir: 'C:\\i', processDir: 'C:\\Program Files\\WindowsApps\\P', stage, probe: true }))
      .toEqual({ stage, probe: true, processDir: 'C:\\Program Files\\WindowsApps\\P' });
  });
  it('NO_SEAMS clears every seam, the probe one included', () => {
    expect(NO_SEAMS).toMatchObject({ TN3270_GUI_PROBE: '', TN3270_GUI_REPLAY: '', TN3270_GUI_SHOT: '', TN3270_GUI_CONNECT: '' });
    expect(Object.values(NO_SEAMS).every((v) => v === '')).toBe(true);
  });
  it('switches end with the given userData, and add --no-sandbox only on a Linux host', () => {
    const s = switches('/u d');
    expect(s.at(-1)).toBe('--user-data-dir=/u d');
    expect(s).toEqual(expect.arrayContaining(['--disable-gpu', '--force-device-scale-factor=1', '--force-color-profile=srgb']));
    expect(s.includes('--no-sandbox')).toBe(process.platform === 'linux');
  });
  it('probeSeen takes the LAST line-start probe: line, or null', () => {
    expect(probeSeen('a\nprobe: sandbox=none windowsStore=false\r\nb\nprobe: sandbox=x windowsStore=true\n'))
      .toBe('probe: sandbox=x windowsStore=true');
    expect(probeSeen('noise probe: sandbox=x windowsStore=true\n')).toBeNull();
    expect(probeSeen('')).toBeNull();
  });
  it('the check names are package-smoke\'s ok lines', () => {
    expect(CHECKS.map(([n]) => n)).toEqual([
      'replays a trace and draws the synthetic-ispf golden',
      'with no host, opens the Connect dialog and connects',
    ]);
  });
});

/**
 * The checks run against a FAKE app (node + a script): it records the env and argv it was given,
 * and plays the app's part -- the shot line and its .sha256 for a replay, the telnet reply and
 * `connect: submitted` for the dialog -- so the staging and probe wiring is driven, not read.
 */
const FAKE = `
import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import net from 'node:net';
const e = process.env;
appendFileSync(e.FAKE_OUT, JSON.stringify({ argv: process.argv.slice(2), REPLAY: e.TN3270_GUI_REPLAY, SHOT: e.TN3270_GUI_SHOT,
  PROBE: e.TN3270_GUI_PROBE, CONNECT: e.TN3270_GUI_CONNECT }) + '\\n');
if (e.TN3270_GUI_PROBE === '1') process.stdout.write('probe: sandbox=fake.id windowsStore=false\\n');
if (e.TN3270_GUI_REPLAY) {
  readFileSync(e.TN3270_GUI_REPLAY);
  writeFileSync(e.TN3270_GUI_SHOT + '.sha256', e.FAKE_HASH + '\\n');
  process.stdout.write('shot: ' + e.TN3270_GUI_SHOT + ' 720x350\\n');
} else {
  const [host, port] = JSON.parse(e.TN3270_GUI_CONNECT).host.split(':');
  process.stdout.write('connect: dialog shown\\n');
  const s = net.connect(Number(port), host, () => process.stdout.write('connect: submitted\\n'));
  s.on('data', () => s.write(Buffer.from([255, 251, 24])));
  s.on('error', () => {});
  setInterval(() => {}, 1000); // stays up, as the app does, until the check kills it
}
`;

describe('package-checks drive the route\'s stage and probe', () => {
  let tmp: string;
  let out: string;
  let fake: string;
  const savedDisplay = process.env.DISPLAY;
  beforeAll(() => {
    // displayEnv passes a set DISPLAY through; unset, it would start this box's Xvfb for a fake.
    process.env.DISPLAY = savedDisplay ?? ':fake';
    tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'pkgchecks-')));
    fake = join(tmp, 'fake-app.mjs');
    writeFileSync(fake, FAKE);
    out = join(tmp, 'seen.jsonl');
  });
  afterAll(() => {
    if (savedDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = savedDisplay;
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const route = (extra: Partial<Route> = {}): Route => ({
    exe: process.execPath, prefix: [fake], installDir: tmp,
    env: { FAKE_OUT: out, FAKE_HASH: readFileSync(GOLDEN, 'utf8').trim() }, ...extra,
  });
  const lastSeen = () => {
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    return JSON.parse(lines[lines.length - 1] ?? '{}') as { argv: string[]; REPLAY?: string; SHOT?: string; PROBE?: string };
  };

  it('default route: the repository trace, a shot in work/shot-*, no probe', async () => {
    const work = mkdtempSync(join(tmp, 'w-'));
    expect(await drawsGolden(route(), work)).toEqual({ note: '', probe: null });
    const s = lastSeen();
    expect(s.REPLAY).toBe(TRACE);
    expect(s.SHOT).toMatch(new RegExp(`^${work.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}[\\\\/]shot-[^\\\\/]+[\\\\/]shot\\.png$`));
    expect(s.argv).toContain(`--user-data-dir=${join(s.SHOT!, '..', 'user-data')}`);
    expect(s.PROBE).toBe('');
  }, 30_000);

  it('a staged route: every path the app gets is the stage\'s, and the probe line comes back', async () => {
    const work = mkdtempSync(join(tmp, 'w-'));
    const box = join(tmp, 'container', 'Data');
    let n = 0;
    const stage = () => {
      const d = join(box, `probe-${++n}`);
      mkdirSync(d, { recursive: true });
      copyFileSync(TRACE, join(d, 'in.trace'));
      return { trace: join(d, 'in.trace'), shot: join(d, 'cap.png'), userData: join(d, 'ud') };
    };
    expect(await drawsGolden(route({ stage, probe: true }), work))
      .toEqual({ note: '', probe: 'probe: sandbox=fake.id windowsStore=false' });
    const s = lastSeen();
    expect(s).toMatchObject({ REPLAY: join(box, 'probe-1', 'in.trace'), SHOT: join(box, 'probe-1', 'cap.png'), PROBE: '1' });
    expect(s.argv).toContain(`--user-data-dir=${join(box, 'probe-1', 'ud')}`);

    expect(await dialogConnects(route({ stage, probe: true }), work))
      .toEqual({ note: '', probe: 'probe: sandbox=fake.id windowsStore=false' });
    expect(lastSeen().argv).toContain(`--user-data-dir=${join(box, 'probe-2', 'ud')}`);
  }, 60_000);

  it('a staged trace the app cannot read fails the check (no pre-check hides it)', async () => {
    const work = mkdtempSync(join(tmp, 'w-'));
    const stage = (d: string) => ({ ...defaultStage(d), trace: join(tmp, 'nowhere.trace') });
    await expect(drawsGolden(route({ stage }), work)).rejects.toThrow(/expected exit 0/);
  }, 30_000);
});

describe('start: no inherited APP_SANDBOX_CONTAINER_ID (it would fake the probe line)', () => {
  it('drops it from the inherited env, the route env and the extra env alike', async () => {
    const saved = { id: process.env.APP_SANDBOX_CONTAINER_ID, display: process.env.DISPLAY };
    process.env.APP_SANDBOX_CONTAINER_ID = 'io.github.athornton.tn3270';
    process.env.DISPLAY = saved.display ?? ':fake';
    const tmp = mkdtempSync(join(tmpdir(), 'pkgchecks-env-'));
    try {
      const r: Route = { exe: process.execPath, prefix: ['-e', 'process.stdout.write("id=" + (process.env.APP_SANDBOX_CONTAINER_ID ?? "unset") + " probe=" + process.env.TN3270_GUI_PROBE)'],
        env: { APP_SANDBOX_CONTAINER_ID: 'from.route' }, probe: true };
      const p = await start(r, [], { APP_SANDBOX_CONTAINER_ID: 'from.extra' }, tmp);
      p.child.stdin.end();
      await p.closed;
      expect(p.stdout).toBe('id=unset probe=1');
    } finally {
      if (saved.id === undefined) delete process.env.APP_SANDBOX_CONTAINER_ID; else process.env.APP_SANDBOX_CONTAINER_ID = saved.id;
      if (saved.display === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = saved.display;
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('exitedWithin leaves no timer pending (the ~2 minute exit tail, CI runs 43065643116 and 43142211500)', () => {
  it('when the launch exits first, the LAUNCH_MS timer is cleared', async () => {
    vi.useFakeTimers();
    try {
      expect(await exitedWithin({ closed: Promise.resolve({ code: 0, signal: null }) }, 120_000)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('when the time runs out first, it says false and leaves nothing either', async () => {
    vi.useFakeTimers();
    try {
      const r = exitedWithin({ closed: new Promise(() => {}) }, 1_000);
      expect(vi.getTimerCount()).toBe(1); // the wait itself holds a real timer while it waits
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await r).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('a node process whose launch exited first exits at once, not LAUNCH_MS later', () => {
    const url = new URL('../../../scripts/package-checks.mjs', import.meta.url).href;
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const { exitedWithin } = await import(${JSON.stringify(url)}); console.log(await exitedWithin({ closed: Promise.resolve() }, 60000));`],
    { encoding: 'utf8', timeout: 50_000 });
    expect(r.stdout.trim()).toBe('true');
    expect(r.status).toBe(0);
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 60_000);
  it('no bare Promise.race against a sleep is left in the launch scripts', () => {
    for (const f of ['package-checks.mjs', 'install-smoke.mjs', 'smoke-lib.mjs', 'store-probe.mjs', 'package-smoke.mjs']) {
      const src = readFileSync(fileURLToPath(new URL(`../../../scripts/${f}`, import.meta.url)), 'utf8');
      expect(src, f).not.toMatch(/Promise\.race\(\[[^\]]*(sleep\(|setTimeout\()/);
    }
  });
});
