import { describe, it, expect } from 'vitest';
import { resolveTerminalType, KNOWN_MODELS, TerminalTypeError } from '../src/termtype.js';
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

  it('lists only models we can honestly claim at 24x80', () => {
    // Stage 2a pins the geometry, so a model implying another size is not
    // offered. Adding one means implementing alternate geometry first.
    expect(Object.keys(KNOWN_MODELS)).toEqual(['3278-2', '3278-2-E']);
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
