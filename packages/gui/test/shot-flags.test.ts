import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Guards the screenshot harness's invocation, which `npm test` cannot run.
 *
 * `pty-smoke.py` sat at 1 of 12 for two days when TLS went on by default, because a harness
 * outside the fast gate is exempt from every change until somebody remembers it. The lesson
 * generalises, so this reads the script as TEXT and pins the things whose absence would
 * disable it silently. `packages/tui/test/harness-flags.test.ts` does the same for the two
 * older harnesses; keep them together in spirit if not in file.
 */
const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const shot = readFileSync(join(guiDir, 'scripts', 'shot.mjs'), 'utf8');

describe('the screenshot harness', () => {
  it('keeps -insecure in the argv it runs the client with', () => {
    // Mandatory even though these runs replay a trace and open no socket: the moment anyone
    // points this at a real host, default-on TLS against plaintext Hercules does not fail,
    // it HANGS.
    const argv = /^const ARGV = \[[^\]]*\]/m.exec(shot);
    expect(argv, 'no ARGV list found in shot.mjs').not.toBeNull();
    expect(argv![0]).toContain("'-insecure'");
  });

  it('keeps --disable-gpu, without which a headless capture HANGS', () => {
    const argv = /^const ARGV = \[[^\]]*\]/m.exec(shot);
    expect(argv![0]).toContain("'--disable-gpu'");
    expect(argv![0]).toContain("'--no-sandbox'");
  });

  it('actually spreads that argv into the process it spawns', () => {
    // Without this half, ARGV could keep saying -insecure while nothing passed it, and the
    // test above would stay green over a harness that hangs.
    expect(shot).toMatch(/spawnSync\(electron, \[main, \.\.\.ARGV/);
  });

  it('takes its goldens from a REPLAYED TRACE, never from a live logon', () => {
    // Goldens live in git forever. A live capture can contain a typed password, and cannot
    // be reproducible if the host paints a clock -- TK5's VTAM panel does exactly that.
    expect(shot).toContain('TN3270_GUI_REPLAY');
    expect(shot).toContain('synthetic-ispf-like.trace');
  });

  it('refuses to accept a blank capture as a pass', () => {
    // A renderer that throws still produces a perfectly valid, perfectly black PNG, which
    // would then match itself forever. Both guards must stay.
    expect(shot).toMatch(/rendererErrors\.length > 0/);
    expect(shot).toMatch(/looks blank/);
  });

  it('compares the RAW BITMAP hash, not the encoded PNG', () => {
    // The PNG encoder is not covered by the determinism argument and can change between
    // Electron versions; comparing the file would break on an upgrade and train people to
    // run --update without looking.
    expect(shot).toContain('.sha256');
    expect(shot).not.toMatch(/readFileSync\([^)]*\.png[^)]*\)\s*\.equals/);
  });

  it('does not re-enable image smoothing anywhere', () => {
    // That single line would make every golden unreproducible.
    expect(shot).not.toContain('imageSmoothingEnabled = true');
  });

  it("threads a case's extraArgv into the process it spawns", () => {
    // Without this, the green golden would be captured with the DEFAULT scheme and would
    // quietly re-baseline to the wrong palette on the next --update. `npm test` cannot see
    // that; this file is the only thing standing between it and a silent wrong baseline.
    expect(shot).toMatch(/\.\.\.\(kase\.extraArgv \?\? \[\]\)/);
    expect(shot).toMatch(/extraArgv:\s*\[['"]-scheme['"]/);
  });
});
