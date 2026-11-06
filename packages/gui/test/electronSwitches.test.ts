import { describe, it, expect } from 'vitest';
import { stripElectronSwitches } from '../src/electronSwitches.js';
import { parseGuiArgs, UsageError } from '../src/args.js';

/** main.ts strips these before `parseGuiArgs`; what is left must be only the user's arguments. */
describe('stripElectronSwitches', () => {
  it('removes the bare switches the harnesses and smokes pass', () => {
    expect(stripElectronSwitches(['--no-sandbox', '--disable-gpu', '-insecure', 'vm:3270']))
      .toEqual(['-insecure', 'vm:3270']);
  });

  it('removes --user-data-dir=<dir>, which package-smoke gives every launch', () => {
    const argv = stripElectronSwitches(['--user-data-dir=/tmp/x y/ud', '--disable-gpu', '-insecure', 'vm:3270']);
    expect(argv).toEqual(['-insecure', 'vm:3270']);
    expect(parseGuiArgs(argv).host).toBe('vm');
  });

  it('keeps the separate-argument form and an empty value, so they fail as unknown flags', () => {
    // Stripping `--user-data-dir` alone would leave its value to be read as the host.
    for (const bad of [['--user-data-dir', '/tmp/ud', 'vm'], ['--user-data-dir=', 'vm']]) {
      const argv = stripElectronSwitches(bad);
      expect(argv).toEqual(bad);
      expect(() => parseGuiArgs(argv)).toThrow(UsageError);
    }
  });

  it('removes the capture-determinism switches the smokes pass (scale factor 1, sRGB)', () => {
    // MEASURED, CI run 3 (2026-11-06): macos-26-intel's display is scale 2 with a colour profile, so
    // its capture was the golden at 1440x700 with greens shifted (36,216,48 -> 43,215,51). These
    // pin the capture to what the golden was recorded under; they must reach Chromium, not us.
    const argv = stripElectronSwitches([
      '--force-device-scale-factor=1', '--force-color-profile=srgb', '-insecure', 'vm:3270']);
    expect(argv).toEqual(['-insecure', 'vm:3270']);
    expect(parseGuiArgs(argv).host).toBe('vm');
  });

  it('never strips our own --terminal-type or its value', () => {
    expect(stripElectronSwitches(['--terminal-type', 'IBM-3278-2', 'vm']))
      .toEqual(['--terminal-type', 'IBM-3278-2', 'vm']);
  });
});
