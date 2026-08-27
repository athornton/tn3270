import { describe, it, expect } from 'vitest';
import {
  resolveTerminalType, resolveAlternateSize, KNOWN_MODELS, TerminalTypeError,
} from '../src/termtype.js';
import { TERMINAL_TYPE } from '../src/constants.js';

describe('terminal type resolution', () => {
  it('defaults to IBM-3278-2, unchanged from stage 1', () => {
    // Must not change: the VM/370 conformance run was recorded with our client
    // negotiating this string. (The committed .trace fixtures replay recorded
    // bytes, so they do not fail on their own if the default changes -- this
    // assertion and telnet.test.ts are what actually catch it.)
    expect(resolveTerminalType({})).toBe('IBM-3278-2');
    expect(resolveTerminalType({})).toBe(TERMINAL_TYPE);
  });

  it('maps a model number to its ttype string', () => {
    expect(resolveTerminalType({ model: '3278-2' })).toBe('IBM-3278-2');
    expect(resolveTerminalType({ model: '3278-2-E' })).toBe('IBM-3278-2-E');
  });

  it('accepts a model with the IBM- prefix already on it', () => {
    // s3270 accepts -model 3278-2; a user typing the full string should work too.
    expect(resolveTerminalType({ model: 'IBM-3278-2-E' })).toBe('IBM-3278-2-E');
  });

  it('passes a raw terminal type through verbatim', () => {
    // The escape hatch for experiments: IBM-DYNAMIC, IBM-3279-2-E, anything.
    expect(resolveTerminalType({ terminalType: 'IBM-DYNAMIC' })).toBe('IBM-DYNAMIC');
    expect(resolveTerminalType({ terminalType: 'IBM-3279-2-E' })).toBe('IBM-3279-2-E');
  });

  it('lets the raw terminal type override a model', () => {
    expect(resolveTerminalType({ model: '3278-2', terminalType: 'IBM-DYNAMIC' }))
      .toBe('IBM-DYNAMIC');
  });

  it('rejects an unknown model rather than guessing a ttype string', () => {
    // A typo must fail loudly. Silently negotiating something the user did not
    // ask for is how a session fails in a way nobody can explain.
    expect(() => resolveTerminalType({ model: '3278-9' })).toThrow(TerminalTypeError);
    expect(() => resolveTerminalType({ model: '' })).toThrow(TerminalTypeError);
  });

  it('names the models it knows in the error, so the message is actionable', () => {
    expect(() => resolveTerminalType({ model: 'bogus' })).toThrow(/3278-2-E/);
  });

  it('rejects an empty raw terminal type', () => {
    expect(() => resolveTerminalType({ terminalType: '' })).toThrow(TerminalTypeError);
  });

  it('offers models 2 through 5, each with its alternate size', () => {
    // This test used to assert ONLY models 2 were listed, on the grounds that
    // stage 2a pinned the geometry at 24x80 and a model implying another size
    // could not be honestly claimed. Alternate-size support is what earned the
    // rest: EW/EWA now switch the buffer, so the claim is now true.
    expect(Object.keys(KNOWN_MODELS)).toEqual([
      '3278-2', '3278-2-E', '3278-3', '3278-3-E',
      '3278-4', '3278-4-E', '3278-5', '3278-5-E',
    ]);
  });

  it('gives every model an alternate size, and only model 2 gets 24x80', () => {
    expect(KNOWN_MODELS['3278-2']!.alternate).toEqual({ rows: 24, cols: 80 });
    expect(KNOWN_MODELS['3278-3']!.alternate).toEqual({ rows: 32, cols: 80 });
    expect(KNOWN_MODELS['3278-4']!.alternate).toEqual({ rows: 43, cols: 80 });
    expect(KNOWN_MODELS['3278-5']!.alternate).toEqual({ rows: 27, cols: 132 });
    // The -E variants differ only in the wire name, never in geometry: -E is an
    // extended-data-stream claim, not a size. Conflating the two is the mistake
    // termtype.ts's own header warns about.
    for (const n of ['2', '3', '4', '5']) {
      expect(KNOWN_MODELS[`3278-${n}-E`]!.alternate)
        .toEqual(KNOWN_MODELS[`3278-${n}`]!.alternate);
      expect(KNOWN_MODELS[`3278-${n}-E`]!.ttype).toBe(`IBM-3278-${n}-E`);
    }
  });

  describe('resolveAlternateSize', () => {
    it('returns the model geometry, and 24x80 for a model 2', () => {
      expect(resolveAlternateSize({ model: '3278-4' })).toEqual({ rows: 43, cols: 80 });
      expect(resolveAlternateSize({ model: 'ibm-3278-5-e' })).toEqual({ rows: 27, cols: 132 });
      expect(resolveAlternateSize({ model: '3278-2' })).toEqual({ rows: 24, cols: 80 });
    });

    it('returns undefined with no model, leaving the session a model 2', () => {
      expect(resolveAlternateSize({})).toBeUndefined();
    });

    it('returns undefined for a raw --terminal-type, deliberately', () => {
      // We cannot know what geometry an arbitrary string implies, and guessing one
      // from a substring would be worse than staying 24x80. Someone who sends
      // IBM-3278-4 this way gets the size they claimed to the host but not a
      // buffer to hold it -- which is why -model exists.
      expect(resolveAlternateSize({ terminalType: 'IBM-3278-4' })).toBeUndefined();
    });

    it('rejects an unknown model, exactly as resolveTerminalType does', () => {
      expect(() => resolveAlternateSize({ model: '3278-9' })).toThrow(TerminalTypeError);
    });
  });

  // x3270 matches the IBM- prefix with strncasecmp and the -E suffix with
  // strchr("Ee", ...) in Common/model.c canonical_model_x(), so a lowercase
  // spelling of either is valid input there. Match that rather than rejecting
  // a spelling s3270 would have accepted.
  it('accepts the IBM- prefix and -E suffix in any case, as x3270 does', () => {
    expect(resolveTerminalType({ model: 'ibm-3278-2' })).toBe('IBM-3278-2');
    expect(resolveTerminalType({ model: 'Ibm-3278-2-E' })).toBe('IBM-3278-2-E');
    expect(resolveTerminalType({ model: '3278-2-e' })).toBe('IBM-3278-2-E');
  });

  // Case folding must not invent models: 3278-9 is still unknown in any case.
  it('still rejects an unknown model spelled in lowercase', () => {
    expect(() => resolveTerminalType({ model: 'ibm-3278-9' })).toThrow(TerminalTypeError);
  });

  // The raw string is the escape hatch, so it is NOT case-folded: a host that
  // wants an exact byte sequence gets exactly what the user typed.
  it('does not case-fold the raw terminal type', () => {
    expect(resolveTerminalType({ terminalType: 'ibm-dynamic' })).toBe('ibm-dynamic');
  });

  // A plain-object table indexed without an own-property check inherits
  // Object.prototype, so 'constructor' would resolve to a function instead of
  // missing the table, and a non-undefined lookup would be treated as a ttype.
  it('does not resolve an inherited Object.prototype key as a model', () => {
    for (const name of ['constructor', 'toString', 'valueOf', '__proto__']) {
      expect(() => resolveTerminalType({ model: name })).toThrow(TerminalTypeError);
    }
  });
});
