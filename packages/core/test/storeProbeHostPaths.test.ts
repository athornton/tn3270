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
