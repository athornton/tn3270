import { describe, it, expect } from 'vitest';
import { TerminalTypeError } from '@tn3270/core';
import { parseArgs, buildSession, UsageError } from '../src/main.js';

/**
 * TLS is ON by default, so every parse carries it. Spelled out in each
 * expectation rather than hidden behind a matcher: the whole point of the
 * default is that it is not silently absent.
 */
const TLS = { kind: 'tls', verify: true } as const;

describe('command line arguments', () => {
  it('defaults to no terminal type override', () => {
    expect(parseArgs([])).toEqual({ tls: TLS });
  });

  it('parses -model', () => {
    expect(parseArgs(['-model', '3278-2-E'])).toEqual({ model: '3278-2-E', tls: TLS });
  });

  it('parses --terminal-type', () => {
    expect(parseArgs(['--terminal-type', 'IBM-DYNAMIC']))
      .toEqual({ terminalType: 'IBM-DYNAMIC', tls: TLS });
  });

  it('accepts both, letting the raw type win at resolution time', () => {
    expect(parseArgs(['-model', '3278-2', '--terminal-type', 'IBM-DYNAMIC']))
      .toEqual({ model: '3278-2', terminalType: 'IBM-DYNAMIC', tls: TLS });
  });

  it('rejects a flag with no value', () => {
    expect(() => parseArgs(['-model'])).toThrow(UsageError);
    expect(() => parseArgs(['--terminal-type'])).toThrow(UsageError);
  });

  it('rejects an unrecognized flag rather than ignoring it', () => {
    // Silently ignoring a flag the user typed is how a session ends up
    // negotiating something nobody asked for.
    expect(() => parseArgs(['--wat'])).toThrow(UsageError);
  });
});

describe('-tn3270e', () => {
  it('is absent by default, meaning the session default applies', () => {
    // Absent rather than `true`: the product default lives in one place (the
    // Session), and having the parser assert it too would let the two drift.
    expect(parseArgs([]).tn3270e).toBeUndefined();
  });

  it('accepts on and off', () => {
    expect(parseArgs(['-tn3270e', 'off']).tn3270e).toBe(false);
    expect(parseArgs(['-tn3270e', 'on']).tn3270e).toBe(true);
  });

  it('rejects a value that is neither', () => {
    expect(() => parseArgs(['-tn3270e', 'maybe'])).toThrow(/on or off|takes on or off/i);
  });

  it('rejects a missing value rather than silently defaulting', () => {
    expect(() => parseArgs(['-tn3270e'])).toThrow(/needs a value/i);
  });
});

describe('-bind-image', () => {
  it('off clears the option', () => {
    expect(parseArgs(['-bind-image', 'off']).bindImage).toBe(false);
  });

  it('defaults to on', () => {
    expect(parseArgs([]).bindImage).not.toBe(false);
  });

  it('rejects a value that is not on or off', () => {
    expect(() => parseArgs(['-bind-image', 'yes'])).toThrow(UsageError);
  });

  it('without a value is a usage error', () => {
    expect(() => parseArgs(['-bind-image'])).toThrow(UsageError);
  });
});

describe('-devname', () => {
  it('sets the device name template', () => {
    expect(parseArgs(['-devname', 'foo===']).devname).toBe('foo===');
  });

  it('has no device name by default', () => {
    expect(parseArgs([]).devname).toBeUndefined();
  });

  it('without a value is a usage error', () => {
    expect(() => parseArgs(['-devname'])).toThrow(UsageError);
  });
});

describe('-oversize', () => {
  it('parses <cols>x<rows>', () => {
    expect(parseArgs(['-oversize', '160x62']).oversize).toEqual({ kind: 'fixed', rows: 62, cols: 160 });
  });

  it('is absent by default', () => {
    expect(parseArgs([]).oversize).toBeUndefined();
  });

  it('rejects a malformed value', () => {
    expect(() => parseArgs(['-oversize', '80'])).toThrow(UsageError);
  });

  it('refuses -oversize with --terminal-type, at parse time', () => {
    expect(() => parseArgs(['-oversize', '160x62', '--terminal-type', 'X']))
      .toThrow(/cannot both be given/);
  });

  it('refuses -oversize auto, at parse time: the CLI has no window to measure', () => {
    expect(() => parseArgs(['-oversize', 'auto'])).toThrow(/needs a window/);
  });

  it('refuses an oversize on a non-extended model, at parse time', () => {
    expect(() => parseArgs(['-model', '3278-2', '-oversize', '160x62']))
      .toThrow(/extended model/);
  });

  it('refuses a fixed oversize below the model floor, at parse time', () => {
    expect(() => parseArgs(['-model', '3278-2-E', '-oversize', '100x20']))
      .toThrow(/use at least/);
  });

  it('refuses a fixed oversize past the 14-bit cell limit, at parse time', () => {
    expect(() => parseArgs(['-oversize', '200x100'])).toThrow(/use at most 16383/);
  });

  it('an unknown model with -oversize is the model error, not an oversize one', () => {
    expect(() => parseArgs(['-model', '9999-X', '-oversize', '160x62']))
      .toThrow(TerminalTypeError);
  });

  it('-oversize none is accepted alongside --terminal-type, unlike a real oversize', () => {
    expect(parseArgs(['--terminal-type', 'X', '-oversize', 'none']))
      .toEqual({ terminalType: 'X', oversize: { kind: 'none' }, tls: TLS });
  });
});

describe('buildSession: what main() actually constructs', () => {
  // conformance-vm.txt (packages/cli/scripts/) requires `-model 3278-2` on our line to match
  // s3270's own `-model 3278-2` byte for byte, i.e. IBM-3278-2 and NOT IBM-3278-2-E. These
  // tests drive `buildSession` -- the function `main()` itself calls, not a copy of its
  // expression or a call to `resolveGeometry` beside it -- so a change to `buildSession`
  // that breaks this is caught here directly, with no separate copy to fall out of step.
  //
  // CHOSEN LEVEL: `buildSession`'s returned `Session`, inspected via `geometrySetting` and
  // `screen.alternateSize` without connecting -- `Session`'s constructor alone resolves both.
  // This proves what the session negotiates for a given argv; it does not spawn the real
  // process or open a socket. Only `conformance-vm.txt`, run against a live host, proves that.

  it('no flags: geometry mode, no model, model-2 alternate (IBM-3278-2-E)', () => {
    const session = buildSession(parseArgs([]));
    expect(session.geometrySetting).toEqual({ oversize: { kind: 'none' } });
    expect(session.screen.alternateSize).toEqual({ rows: 24, cols: 80 });
  });

  it('-model 3278-2: geometry mode, bare model, no -E implied', () => {
    const session = buildSession(parseArgs(['-model', '3278-2']));
    expect(session.geometrySetting).toEqual({ model: '3278-2', oversize: { kind: 'none' } });
    expect(session.screen.alternateSize).toEqual({ rows: 24, cols: 80 });
  });

  it('-model 3278-4-E: geometry mode, model 4\'s 43x80 alternate', () => {
    const session = buildSession(parseArgs(['-model', '3278-4-E']));
    expect(session.geometrySetting).toEqual({ model: '3278-4-E', oversize: { kind: 'none' } });
    expect(session.screen.alternateSize).toEqual({ rows: 43, cols: 80 });
  });

  it('-oversize 160x62: geometry mode, the oversize carried in the setting for the next connect', () => {
    const session = buildSession(parseArgs(['-oversize', '160x62']));
    expect(session.geometrySetting).toEqual({ oversize: { kind: 'fixed', rows: 62, cols: 160 } });
    // NOT yet 62x160: the oversize is resolved at connect(), not at construction -- see
    // `Session`'s constructor comment ("THE MODEL'S GEOMETRY, NOT THE OVERSIZE'S"). Before
    // any connect the screen starts at the bare model's own alternate, model 2's 24x80 here.
    expect(session.screen.alternateSize).toEqual({ rows: 24, cols: 80 });
  });

  it('no measure function: Set(oversize,auto) -- via setGeometry, which validates the same '
    + 'way -- is refused for "no window to measure", which only holds absent one', () => {
    // `Session` exposes no getter for its `measure` option (deliberately -- see
    // `SessionOptions.measure`'s own comment, "a SESSION option ... kept for the session's
    // lifetime"), so this is checked through its effect rather than directly: `setGeometry`
    // runs the identical validation `Set(oversize,...)` runs in `runner.ts` (`resolveGeometry`
    // against a stand-in that reports "no window" when a REAL measure function was given, and
    // geometry.ts's own refusal when none was). The CLI's `buildSession` never passes
    // `measure` -- it has no window to measure -- so this is the test that would catch it
    // starting to.
    const session = buildSession(parseArgs([]));
    expect(() => session.setGeometry({ oversize: { kind: 'auto' } }))
      .toThrow(/oversize auto needs a window to measure/);
  });

  it('--terminal-type: legacy mode, no geometry setting at all', () => {
    const session = buildSession(parseArgs(['--terminal-type', 'IBM-DYNAMIC']));
    expect(session.geometrySetting).toBeUndefined();
  });
});

describe('-bind-limit', () => {
  it('off lets an out-of-range BIND geometry through', () => {
    expect(parseArgs(['-bind-limit', 'off']).bindLimit).toBe(false);
  });

  it('defaults to on', () => {
    expect(parseArgs([]).bindLimit).not.toBe(false);
  });

  it('rejects a value that is not on or off', () => {
    expect(() => parseArgs(['-bind-limit', 'yes'])).toThrow(UsageError);
  });

  it('without a value is a usage error', () => {
    expect(() => parseArgs(['-bind-limit'])).toThrow(UsageError);
  });
});
