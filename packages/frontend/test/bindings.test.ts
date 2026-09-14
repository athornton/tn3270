import { describe, it, expect } from 'vitest';
import { BINDING_INTENT } from '../src/bindings.js';
import { lookup, PARTIAL } from '../src/keymap.js';

const bytes = (s: string): Uint8Array =>
  Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0) & 0xff));

const show = (s: string): string => s.replace(/\x1b/g, 'ESC').replace(/\r/g, 'CR')
  .replace(/\t/g, 'TAB').replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16)}`);

describe('BINDING_INTENT', () => {
  it('names an action for every entry, with no duplicate keys', () => {
    const keys = BINDING_INTENT.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const b of BINDING_INTENT) expect(b.action.kind).toBeTruthy();
  });

  it('agrees with the TERMINAL keymap wherever the entry gives a sequence', () => {
    // This is the assertion that gives the table teeth. An entry claiming Ctrl-R is
    // Reset, against a keymap that says otherwise, is a contradiction one of the front
    // ends would inherit. A guessed byte fails here immediately, which is the point.
    for (const b of BINDING_INTENT) {
      if (b.terminal === undefined) continue;
      const got = lookup(bytes(b.terminal));
      const label = `${b.key} -> ${show(b.terminal)}`;
      expect(got, label).not.toBe(PARTIAL);
      expect(got, label).not.toBeNull();
      expect((got as { kind: string }).kind, label).toBe(b.action.kind);
    }
  });

  it('agrees on the NUMBER too, for the keys that carry one', () => {
    // `kind: 'pf'` alone would let F3 claim to be PF7 and still pass. The number is
    // most of the meaning of a PF key.
    for (const b of BINDING_INTENT) {
      if (b.terminal === undefined) continue;
      const got = lookup(bytes(b.terminal)) as { kind: string; n?: number };
      if ('n' in b.action) expect(got.n, b.key).toBe(b.action.n);
    }
  });

  it('covers Clear, Reset and Enter, the three a 3270 user cannot work without', () => {
    const kinds = BINDING_INTENT.map((b) => b.action.kind);
    for (const needed of ['clear', 'reset', 'enter']) expect(kinds).toContain(needed);
  });

  it('documents the way OUT, because Ctrl-C cannot be it', () => {
    // Ctrl-C is the Clear AID here. That is correct for a 3270 and surprising to
    // everyone, so the escape hatch has to be written down somewhere both front ends
    // read -- an undocumented Ctrl-] is no escape hatch.
    const quit = BINDING_INTENT.find((b) => b.action.kind === 'quit');
    expect(quit, 'no quit binding is documented').toBeDefined();
    expect(quit!.key).toMatch(/Ctrl-\]/);
  });

  it('leaves `terminal` undefined exactly where the keymap has TWO encodings', () => {
    // The arrows and Home have both SS3 and CSI forms, so a single expected sequence
    // would assert less than keymap.test.ts already does. Pinning that these entries
    // are deliberately sequence-less stops someone "completing" the table with one of
    // the two and quietly implying the other is wrong.
    for (const key of ['Up', 'Down', 'Left', 'Right', 'Home']) {
      const entry = BINDING_INTENT.find((b) => b.key === key);
      expect(entry, `${key} missing`).toBeDefined();
      expect(entry!.terminal, key).toBeUndefined();
    }
  });
});
