import { describe, it, expect } from 'vitest';
import { parseKeySpec } from '../src/keyspec.js';

/**
 * The parser for the `TN3270_GUI_KEYS` seam.
 *
 * THE REFUSALS ARE THE POINT OF THIS FILE. Measured on Electron 44.0.0: a DOM code name
 * like `Digit1` or `ArrowUp` is not an invalid keyCode, it is an EMPTY one -- Chromium
 * delivers `key: ''`, `code: ''`, `keyCode: 0`, `actionForKey` returns null, no action is
 * sent, and the harness still exits 0 reporting that it sent the key. Our own keymap is
 * written in terms of `e.code`, so that spelling is the one a reader reaches for first.
 */
describe('parseKeySpec', () => {
  it('parses a bare key with no modifiers', () => {
    expect(parseKeySpec('1')).toEqual({ keyCode: '1', modifiers: [] });
  });

  it('parses the Alt chord the PA keys need', () => {
    expect(parseKeySpec('Alt+1')).toEqual({ keyCode: '1', modifiers: ['alt'] });
  });

  it('keeps multiple modifiers in the order written', () => {
    expect(parseKeySpec('Ctrl+Shift+F1')).toEqual({
      keyCode: 'F1', modifiers: ['control', 'shift'],
    });
  });

  it('accepts every spelling of each modifier, case-insensitively', () => {
    expect(parseKeySpec('CTRL+c').modifiers).toEqual(['control']);
    expect(parseKeySpec('control+c').modifiers).toEqual(['control']);
    expect(parseKeySpec('Option+2').modifiers).toEqual(['alt']);
    expect(parseKeySpec('Cmd+a').modifiers).toEqual(['meta']);
    expect(parseKeySpec('Command+a').modifiers).toEqual(['meta']);
    expect(parseKeySpec('Super+a').modifiers).toEqual(['meta']);
  });

  it('passes the key through VERBATIM, including punctuation', () => {
    // ']' arrives as code BracketRight; nothing here normalises it.
    expect(parseKeySpec('Ctrl+]')).toEqual({ keyCode: ']', modifiers: ['control'] });
  });

  it('handles a literal plus as the key', () => {
    // A naive split-and-pop turns '+' into an empty key and then into an empty event.
    expect(parseKeySpec('+')).toEqual({ keyCode: '+', modifiers: [] });
    expect(parseKeySpec('Ctrl++')).toEqual({ keyCode: '+', modifiers: ['control'] });
  });

  it('de-duplicates a repeated modifier', () => {
    expect(parseKeySpec('Alt+Alt+1').modifiers).toEqual(['alt']);
  });

  it('trims surrounding whitespace', () => {
    expect(parseKeySpec('  Alt+1  ')).toEqual({ keyCode: '1', modifiers: ['alt'] });
  });

  it('REFUSES a DOM code name, naming the valid spelling', () => {
    expect(() => parseKeySpec('Digit1')).toThrow(/Digit1.*empty/i);
    expect(() => parseKeySpec('Digit1')).toThrow(/use '1'/);
    expect(() => parseKeySpec('ArrowUp')).toThrow(/use 'Up'/);
    expect(() => parseKeySpec('KeyA')).toThrow(/use 'a'/);
    // No hint exists for this one, but it is still refused rather than passed through.
    expect(() => parseKeySpec('Numpad0')).toThrow(/empty/i);
    // And the refusal survives a modifier prefix, which is how it would really be written.
    expect(() => parseKeySpec('Alt+Digit1')).toThrow(/use '1'/);
  });

  it('refuses an unknown modifier name rather than passing it to Chromium', () => {
    // 'Ctl+1' would otherwise reach sendInputEvent verbatim and deliver an empty event.
    expect(() => parseKeySpec('Ctl+1')).toThrow(/unknown modifier/i);
  });

  it('refuses modifiers with no key, and an empty spec', () => {
    expect(() => parseKeySpec('Alt+')).toThrow(/no key/i);
    expect(() => parseKeySpec('')).toThrow(/empty/i);
    expect(() => parseKeySpec('   ')).toThrow(/empty/i);
  });
});
