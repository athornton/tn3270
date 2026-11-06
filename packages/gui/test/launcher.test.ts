import { constants } from 'node:os';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORWARDED, bundleMissing, electronMissing, exitPlan, sandboxHint } from '../bin/launch.mjs';

/**
 * `tn3270-gui`'s decisions, without Electron. That the launcher actually RUNS the app and draws
 * the golden pixels is `scripts/install-smoke.mjs`'s gui check, from the packed tarball.
 */
describe('tn3270-gui exitPlan', () => {
  it('passes an exit code through, and a missing one is a failure', () => {
    expect(exitPlan(0, null, 'linux')).toEqual({ exit: 0 });
    expect(exitPlan(3, null, 'linux')).toEqual({ exit: 3 });
    expect(exitPlan(null, null, 'linux')).toEqual({ exit: 1 });
  });

  it('re-raises a termination signal on POSIX, so the parent sees what Electron died of', () => {
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL'] as const) {
      expect(exitPlan(null, s, 'linux')).toEqual({ raise: s });
      expect(exitPlan(null, s, 'darwin')).toEqual({ raise: s });
    }
  });

  it('turns a crash signal into 128+n rather than re-raising it (which would dump core)', () => {
    // Expected from THIS host's signal table, not Linux's numbers: on Windows `os.constants.signals`
    // has no SIGTRAP (first Windows CI run, 2026-11-06: got 128). The rule is 128 + n; n is local.
    const n = (sig: 'SIGTRAP' | 'SIGSEGV') => (constants.signals as Record<string, number>)[sig] ?? 0;
    expect(exitPlan(null, 'SIGTRAP', 'linux')).toEqual({ exit: 128 + n('SIGTRAP') });
    expect(exitPlan(null, 'SIGSEGV', 'linux')).toEqual({ exit: 128 + n('SIGSEGV') });
    if (process.platform !== 'win32') {
      expect(exitPlan(null, 'SIGTRAP', 'linux')).toEqual({ exit: 133 });
      expect(exitPlan(null, 'SIGSEGV', 'linux')).toEqual({ exit: 139 });
    }
  });

  it('never re-raises on Windows', () => {
    expect(exitPlan(null, 'SIGTERM', 'win32')).toEqual({ exit: 143 });
  });
});

describe('tn3270-gui messages', () => {
  it('forwards the three signals a user or terminal sends', () => {
    expect([...FORWARDED]).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP']);
  });

  it('every remedy leads with what to do', () => {
    expect(bundleMissing('/x/app/BUNDLED')).toMatch(/^tn3270-gui: reinstall @tn3270\/gui .*\/x\/app\/BUNDLED is missing/);
    const m = electronMissing(new Error('Electron failed to install correctly.'));
    expect(m).toContain('Electron failed to install correctly.');
    expect(m).toContain('npm install -g @tn3270/gui');
    const h = sandboxHint('/p/chrome-sandbox');
    expect(h).toContain('chown root:root /p/chrome-sandbox && chmod 4755 /p/chrome-sandbox');
    expect(h).toContain('--no-sandbox');
  });

  it('the launcher never adds --no-sandbox itself', () => {
    const src = readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), 'bin', 'tn3270-gui.mjs'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('no-sandbox');
  });
});
