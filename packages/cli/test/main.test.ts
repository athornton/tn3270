import { describe, it, expect } from 'vitest';
import { resolveGeometry } from '@tn3270/core';
import { parseArgs, UsageError } from '../src/main.js';

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
});

describe('-model 3278-2 still negotiates the bare terminal type (conformance-vm.txt)', () => {
  // conformance-vm.txt (packages/cli/scripts/) requires `-model 3278-2` on our line to match
  // s3270's own `-model 3278-2` byte for byte, i.e. IBM-3278-2 and NOT IBM-3278-2-E. `main()`
  // now builds every session (without --terminal-type) through geometry mode, so the thing to
  // prove is that geometry mode's resolve -- not just the legacy path it replaced -- still
  // answers IBM-3278-2 for a bare `-model 3278-2`.
  //
  // CHOSEN LEVEL: `resolveGeometry` directly (geometry.ts's own contract), plus `main()`'s
  // literal setting-construction expression fed `parseArgs`' real output -- not a spawned
  // process reading a real socket, which `main()` cannot be driven through in a unit test. This
  // proves the wire name geometry mode would negotiate for this exact argv; it does not run the
  // process. The conformance script itself is the one thing that proves the running binary.

  it('resolveGeometry(model 3278-2, no oversize) answers IBM-3278-2, not -E', () => {
    expect(resolveGeometry({ model: '3278-2', oversize: { kind: 'none' } }).terminalType)
      .toBe('IBM-3278-2');
  });

  it('the setting main() builds from "-model 3278-2" resolves to IBM-3278-2', () => {
    const args = parseArgs(['-model', '3278-2']);
    // Confirms geometry mode is in fact the path taken: no --terminal-type was given.
    expect(args.terminalType).toBeUndefined();
    // main()'s own construction, verbatim (packages/cli/src/main.ts).
    const setting = {
      ...(args.model !== undefined ? { model: args.model } : {}),
      oversize: args.oversize ?? { kind: 'none' as const },
    };
    expect(resolveGeometry(setting).terminalType).toBe('IBM-3278-2');
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
