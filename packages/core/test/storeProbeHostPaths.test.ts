/**
 * The routes on the OTHER host: `node:path`'s host functions are swapped for win32's or posix's,
 * so a Linux box also catches a route that uses host `join` instead of its target's rules (the
 * verify-signatures bug of CI run 42844605289 showed only on a Windows runner). `posix` and
 * `win32` themselves stay real. Its own file: vi.mock is per file.
 */
import { describe, it, expect, vi } from 'vitest';

const host = vi.hoisted(() => ({ rules: 'win32' as 'win32' | 'posix' }));
vi.mock('node:path', async () => {
  const real = await vi.importActual<typeof import('node:path')>('node:path');
  const pick = () => real[host.rules];
  const wrapped: Record<string, unknown> = {};
  for (const k of ['join', 'resolve', 'normalize', 'dirname', 'basename', 'extname', 'relative', 'isAbsolute', 'parse', 'format']) {
    wrapped[k] = (...a: unknown[]) => (pick()[k as 'join'] as (...x: unknown[]) => unknown)(...a);
  }
  const mod = { ...real, ...wrapped, posix: real.posix, win32: real.win32 };
  return { ...mod, default: mod };
});

const { macRoute, winRoute, containerPath } = await import('../../../scripts/store-probe.mjs');

const io = { home: '/Users/runner', trace: '/repo/t.trace', fs: { mkdir: () => {}, copy: () => {} } };

describe('route paths do not depend on the host\'s path rules', () => {
  it.each(['win32', 'posix'] as const)('host rules %s: mac paths use /, Windows paths use \\', (rules) => {
    host.rules = rules;
    const m = macRoute(io, '/scratch/TN3270.app');
    expect(m.exe).toBe('/scratch/TN3270.app/Contents/MacOS/TN3270');
    const s = m.stage!('anything');
    for (const p of [s.trace, s.shot, s.userData, containerPath('/Users/runner')]) {
      expect(p, p).toMatch(/^\/Users\/runner\/Library\/Containers\/io\.github\.athornton\.tn3270(\/|$)/);
      expect(p).not.toContain('\\');
    }
    const w = winRoute(io, { alias: 'C:\\W\\tn3270-gui.exe', installLocation: 'C:\\P\\TN3270.Probe_x' }).stage!('C:\\scratch\\shot-1');
    expect([w.shot, w.userData]).toEqual(['C:\\scratch\\shot-1\\shot.png', 'C:\\scratch\\shot-1\\user-data']);
  });
});

describe('main\'s drivers do not depend on the host\'s path rules', () => {
  it.each(['win32', 'posix'] as const)('host rules %s: the darwin driver\'s paths use /, the win32 driver\'s use \\', async (rules) => {
    host.rules = rules;
    const { main } = await import('../../../scripts/store-probe.mjs');
    const { macWorld, winWorld, MAC_DIR, WIN_DIR, WIN_WORK, SIGNTOOL } = await import('./helpers/storeProbeWorld.js');
    const m = macWorld();
    expect(await main([MAC_DIR], m.io)).toBe(0);
    const macPaths = m.calls.filter((c) => c[0] === 'codesign' || c[0] === 'ditto' || c[0] === 'find').map((c) => c.find((a) => a.startsWith('/scratch'))!);
    expect(macPaths.length).toBeGreaterThan(10);
    for (const p of macPaths) expect(p, p).not.toContain('\\');
    expect(m.events).toContain('rm /Users/runner/Library/Containers/io.github.athornton.tn3270');
    const w = winWorld();
    expect(await main([WIN_DIR], w.io)).toBe(0);
    expect(w.calls.find((c) => c[0] === SIGNTOOL)!.slice(4)).toEqual(['/f', `${WIN_WORK}\\probe.pfx`, '/p', expect.any(String), `${WIN_WORK}\\TN3270-0.1.4-win-x64.appx`]);
  });
});
