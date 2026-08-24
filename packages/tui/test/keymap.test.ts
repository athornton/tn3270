import { describe, expect, it } from 'vitest';
import { PF_AIDS } from '@tn3270/core';
import { isValidPf, lookup, PARTIAL, type Action } from '../src/keymap.js';

/** Feed a string as bytes and expect exactly one action. */
function one(seq: string): Action {
  const r = lookup(Uint8Array.from([...seq].map((c) => c.charCodeAt(0))));
  expect(r).not.toBe(PARTIAL);
  expect(r).not.toBeNull();
  return r as Action;
}

describe('function keys', () => {
  it('maps xterm F1-F4 (SS3) to PF1-PF4', () => {
    expect(one('\x1bOP')).toEqual({ kind: 'pf', n: 1 });
    expect(one('\x1bOQ')).toEqual({ kind: 'pf', n: 2 });
    expect(one('\x1bOR')).toEqual({ kind: 'pf', n: 3 });
    expect(one('\x1bOS')).toEqual({ kind: 'pf', n: 4 });
  });

  it('maps CSI-tilde F5-F12 to PF5-PF12', () => {
    expect(one('\x1b[15~')).toEqual({ kind: 'pf', n: 5 });
    expect(one('\x1b[17~')).toEqual({ kind: 'pf', n: 6 });
    expect(one('\x1b[24~')).toEqual({ kind: 'pf', n: 12 });
  });

  it('maps shifted F1-F12 to PF13-PF24', () => {
    // c3270's convention: Shift+Fn is PF(n+12).
    expect(one('\x1b[1;2P')).toEqual({ kind: 'pf', n: 13 });
    expect(one('\x1b[24;2~')).toEqual({ kind: 'pf', n: 24 });
  });

  it('maps every one of PF1-PF24 from the measured terminfo sequence', () => {
    // The whole table, against `tput -T xterm-256color kf1..kf24` as measured on
    // this box. Spot-checking three of twenty-four would leave a transposed
    // middle entry (F7-F11 are 18/19/20/21/23 -- note the GAP at 22) undetected.
    const measured: readonly [string, number][] = [
      ['\x1bOP', 1], ['\x1bOQ', 2], ['\x1bOR', 3], ['\x1bOS', 4],
      ['\x1b[15~', 5], ['\x1b[17~', 6], ['\x1b[18~', 7], ['\x1b[19~', 8],
      ['\x1b[20~', 9], ['\x1b[21~', 10], ['\x1b[23~', 11], ['\x1b[24~', 12],
      ['\x1b[1;2P', 13], ['\x1b[1;2Q', 14], ['\x1b[1;2R', 15], ['\x1b[1;2S', 16],
      ['\x1b[15;2~', 17], ['\x1b[17;2~', 18], ['\x1b[18;2~', 19], ['\x1b[19;2~', 20],
      ['\x1b[20;2~', 21], ['\x1b[21;2~', 22], ['\x1b[23;2~', 23], ['\x1b[24;2~', 24],
    ];
    for (const [seq, n] of measured) {
      expect(one(seq), `PF${n}`).toEqual({ kind: 'pf', n });
    }
    // And all twenty-four must be distinct, which a copy-paste slip would break.
    expect(new Set(measured.map(([, n]) => n)).size).toBe(24);
    // The keymap must bind exactly as many PF keys as core has AID bytes for.
    // Pinning it against core rather than against the literal 24 means adding a
    // key to one table without the other cannot pass.
    expect(measured.length).toBe(PF_AIDS.length);
  });
});

describe('isValidPf', () => {
  it('accepts 1 through the number of PF AIDs core defines, and nothing else', () => {
    expect(isValidPf(1)).toBe(true);
    expect(isValidPf(PF_AIDS.length)).toBe(true);
    expect(isValidPf(0)).toBe(false);
    expect(isValidPf(PF_AIDS.length + 1)).toBe(false);
    expect(isValidPf(-1)).toBe(false);
    expect(isValidPf(1.5)).toBe(false);
    expect(isValidPf(Number.NaN)).toBe(false);
  });
});

describe('navigation and editing', () => {
  it('maps the arrow keys', () => {
    expect(one('\x1b[A')).toEqual({ kind: 'up' });
    expect(one('\x1b[B')).toEqual({ kind: 'down' });
    expect(one('\x1b[C')).toEqual({ kind: 'right' });
    expect(one('\x1b[D')).toEqual({ kind: 'left' });
  });

  it('ALSO maps the SS3 arrows, which is what terminfo actually reports', () => {
    // MEASURED, and it corrects the plan: `tput -T xterm-256color kcuu1` gives
    // `\x1bOA`, not the `\x1b[A` the plan's test above uses. Both are real. The
    // CSI form is what xterm sends in normal cursor mode; the SS3 form is what it
    // sends after DECCKM is set, and `smkx` is `\x1b[?1h\x1b=` -- so terminfo
    // reports the application-mode sequence because terminfo assumes smkx was
    // sent. A multiplexer or a `smkx` from any layer flips which one arrives, so
    // supporting only one encoding loses the arrow keys outright.
    expect(one('\x1bOA')).toEqual({ kind: 'up' });
    expect(one('\x1bOB')).toEqual({ kind: 'down' });
    expect(one('\x1bOC')).toEqual({ kind: 'right' });
    expect(one('\x1bOD')).toEqual({ kind: 'left' });
  });

  it('maps Return to Enter and Tab to field navigation', () => {
    expect(one('\r')).toEqual({ kind: 'enter' });
    expect(one('\t')).toEqual({ kind: 'tab' });
    expect(one('\x1b[Z')).toEqual({ kind: 'backTab' });
  });

  it('maps Backspace and Delete', () => {
    expect(one('\x7f')).toEqual({ kind: 'backspace' });
    expect(one('\x1b[3~')).toEqual({ kind: 'delete' });
  });

  it('maps Home and End of field', () => {
    expect(one('\x1b[H')).toEqual({ kind: 'home' });
    expect(one('\x1b[4~')).toEqual({ kind: 'eraseEOF' });
  });

  it('ALSO maps SS3 Home, for the same reason as the SS3 arrows', () => {
    // `tput khome` is `\x1bOH`, again the application-mode form.
    expect(one('\x1bOH')).toEqual({ kind: 'home' });
  });

  it('maps Ctrl-U to erase input', () => {
    expect(one('\x15')).toEqual({ kind: 'eraseInput' });
  });
});

describe('the AIDs that are not function keys', () => {
  it('maps Ctrl-C to Clear, NOT to interrupt', () => {
    // Raw mode must intercept it: Clear is a 3270 AID a user needs constantly
    // (it is how MORE... is dismissed), and there is a documented way out below.
    expect(one('\x03')).toEqual({ kind: 'clear' });
  });

  it('maps Ctrl-] to quit, which is the documented escape hatch', () => {
    expect(one('\x1d')).toEqual({ kind: 'quit' });
  });

  it('maps Escape-2 and Escape-1 to PA2 and PA1', () => {
    expect(one('\x1b2')).toEqual({ kind: 'pa', n: 2 });
    expect(one('\x1b1')).toEqual({ kind: 'pa', n: 1 });
  });

  it('maps Ctrl-R to Reset', () => {
    expect(one('\x12')).toEqual({ kind: 'reset' });
  });
});

describe('ordinary characters', () => {
  it('passes printable ASCII through as typed text', () => {
    expect(one('A')).toEqual({ kind: 'type', text: 'A' });
    expect(one(' ')).toEqual({ kind: 'type', text: ' ' });
    expect(one('~')).toEqual({ kind: 'type', text: '~' });
  });

  it('passes a whole printable run through as one action, for paste', () => {
    // A paste arrives as one chunk on stdin. Typing it a byte at a time would
    // work too, but only if the caller re-entered lookup per byte; returning the
    // run keeps that decision here rather than splitting it across two modules.
    expect(one('HELLO')).toEqual({ kind: 'type', text: 'HELLO' });
  });

  it('does not treat a control byte as printable', () => {
    // 0x00-0x1f and 0x80+ are not typeable on a 3270; an unmapped one must be
    // discarded rather than sent to the host as text.
    expect(lookup(Uint8Array.from([0x00]))).toBeNull();
    expect(lookup(Uint8Array.from([0x01]))).toBeNull();
    expect(lookup(Uint8Array.from([0xff]))).toBeNull();
  });
});

describe('the ambiguous-Escape problem', () => {
  it('reports a bare Escape as PARTIAL, not as an action', () => {
    // A lone ESC is indistinguishable from the start of a sequence until either
    // more bytes arrive or a timeout fires. Guessing wrong either eats the next
    // keystroke or emits a spurious PA. app.ts resolves it with a timer.
    expect(lookup(Uint8Array.from([0x1b]))).toBe(PARTIAL);
  });

  it('reports an incomplete CSI as PARTIAL', () => {
    expect(lookup(Uint8Array.from([0x1b, 0x5b]))).toBe(PARTIAL);
    expect(lookup(Uint8Array.from([0x1b, 0x5b, 0x31]))).toBe(PARTIAL);  // "\x1b[1"
  });

  it('reports an incomplete SS3 as PARTIAL', () => {
    // `\x1bO` is the prefix of PF1-PF4, the SS3 arrows and SS3 Home at once.
    expect(lookup(Uint8Array.from([0x1b, 0x4f]))).toBe(PARTIAL);
  });

  it('returns null for a sequence that can never match', () => {
    // Distinct from PARTIAL: the caller must DISCARD these, not keep waiting.
    expect(lookup(Uint8Array.from([0x1b, 0x5b, 0xff]))).toBeNull();
  });

  it('distinguishes PARTIAL from null on a prefix that is also complete', () => {
    // `\x1b[1` is a live prefix (of `\x1b[1;2P`) but `\x1b[1q` is not, and the
    // caller's responses differ: keep buffering versus throw away.
    expect(lookup(Uint8Array.from([0x1b, 0x5b, 0x31]))).toBe(PARTIAL);
    expect(lookup(Uint8Array.from([0x1b, 0x5b, 0x31, 0x71]))).toBeNull();
  });

  it('never returns PARTIAL for an empty buffer', () => {
    // app.ts calls this whenever stdin fires; a zero-length chunk must not put
    // the reader into a waiting state that only a timeout can leave.
    expect(lookup(Uint8Array.from([]))).toBeNull();
  });
});
