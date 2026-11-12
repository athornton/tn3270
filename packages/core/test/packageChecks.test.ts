import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHECKS, GOLDEN, NO_SEAMS, TRACE, defaultStage, dialogConnects, drawsGolden, probeSeen, routeDefaults, switches,
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
