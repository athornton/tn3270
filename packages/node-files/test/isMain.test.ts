import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain } from '../src/isMain.js';

describe('isMain', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  function fixture(): { real: string; url: string } {
    dir = mkdtempSync(join(tmpdir(), 'ismain-'));
    const real = join(dir, 'main.js');
    writeFileSync(real, '');
    return { real, url: pathToFileURL(real).href };
  }

  it('is true when argv[1] is the module itself', () => {
    const { real, url } = fixture();
    expect(isMain(url, real)).toBe(true);
  });

  // npm's symlink is the actual failure mode this whole file exists to fix: the OLD guard
  // (`import.meta.url === \`file://${process.argv[1]}\``) compares the module's own URL against
  // argv[1] with no path resolution at all, so it is FALSE through a symlink -- the installed bin
  // exits 0 having done nothing, which is exactly what was measured 2026-11-05. Skipped only when
  // this process genuinely cannot make a symlink (Windows without the privilege); on Linux, where
  // this suite runs, it always runs.
  const canSymlink = (() => {
    const probeDir = mkdtempSync(join(tmpdir(), 'ismain-probe-'));
    try {
      const target = join(probeDir, 'target');
      writeFileSync(target, '');
      symlinkSync(target, join(probeDir, 'link'));
      return true;
    } catch {
      return false;
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  })();

  it.skipIf(!canSymlink)(
    'is true when argv[1] is a SYMLINK to the module -- how npm installs a bin on POSIX',
    () => {
      const { real, url } = fixture();
      const link = join(dir!, 'tn3270');
      symlinkSync(real, link);
      expect(isMain(url, link)).toBe(true);
    },
  );

  it('is false when the module is imported by another program', () => {
    const { url } = fixture();
    const other = join(dir!, 'other.js');
    writeFileSync(other, '');
    expect(isMain(url, other)).toBe(false);
  });

  it('is false, not a throw, when argv[1] is absent or does not exist', () => {
    const { url } = fixture();
    expect(isMain(url, undefined)).toBe(false);
    expect(isMain(url, join(dir!, 'nope.js'))).toBe(false);
  });

  it('is true for an argv[1] spelled with a different but equivalent path', () => {
    const { real, url } = fixture();
    // `join(dir, '.', 'main.js')` would normalize the `.` away before isMain ever saw it, which
    // would not exercise path resolution at all. Built by string concatenation instead, so the
    // literal `/./` and `/../<dirname>/` survive into argv1 and realpathSync has to collapse them.
    const unnormalizedDot = `${dir}/./main.js`;
    expect(unnormalizedDot).not.toBe(real);
    expect(isMain(url, unnormalizedDot)).toBe(true);

    const unnormalizedDotDot = `${dir}/../${basename(dir!)}/main.js`;
    expect(unnormalizedDotDot).not.toBe(real);
    expect(isMain(url, unnormalizedDotDot)).toBe(true);

    // Sanity: dirname/basename really do reconstruct dir, so the /../ case above is meaningful
    // and not accidentally pointing somewhere else.
    expect(dirname(real)).toBe(dir);
  });
});
