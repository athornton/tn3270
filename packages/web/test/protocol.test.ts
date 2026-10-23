import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PA_AIDS, PF_AIDS } from '@tn3270/core';
import type { DrawCell } from '@tn3270/canvas';
import { encodeServerMessage, decodeClientMessage, type ServerMessage } from '../src/protocol.js';

/**
 * A realistic screenful of cells: EVERY field `DrawCell` declares, because a test object that
 * omits half the shape is weak evidence about how the real thing compresses. The plan's version
 * carried only `x, y, glyph, fg, bg` and hid the gap behind `as never`.
 */
function screenful(): DrawCell[] {
  return Array.from({ length: 1920 }, (_, i) => ({
    x: (i % 80) * 9,
    y: Math.floor(i / 80) * 14,
    glyph: 64,
    fg: [0, 255, 0] as const,
    bg: [0, 0, 0] as const,
    cursor: i === 0,
    underline: false,
    blink: false,
    intensify: false,
  }));
}

describe('encodeServerMessage', () => {
  it('emits a ZLIB-wrapped deflate stream, because that is what the browser expects', () => {
    // MEASURED: DecompressionStream('deflate') wants RFC 1950, which zlib.deflateSync emits.
    // deflateRawSync emits RFC 1951, which has NO header -- its leading bytes are compressed data
    // (measured `ab 56` for this payload but `4b 04` for "a", so the `ab a8` quoted elsewhere is
    // payload-specific rather than a signature) -- and would need 'deflate-raw'. Mismatch these and
    // EVERY frame silently fails to inflate in the browser.
    const out = encodeServerMessage({ kind: 'error', message: 'x' });
    expect(out[0]).toBe(0x78);
    // This pins the FORMAT, not the compression LEVEL. MEASURED: the second byte is 01/5e/9c/da for
    // levels 0/1/6/9, so `toBe(0x9c)` would break on a level change that still emits perfectly
    // valid zlib. RFC 1950's FCHECK rule is level-independent: CMF*256 + FLG must be a multiple of
    // 31. VERIFIED to still catch the trap this test exists for -- under deflateRawSync this
    // assertion fails on its own (0xab56 = 43862, which is 28 mod 31), not just via the byte above.
    expect((out[0]! * 256 + out[1]!) % 31).toBe(0);
  });

  it('round-trips a frame message', () => {
    const msg = { kind: 'frame' as const, list: { width: 2, height: 3, cells: [] } };
    expect(JSON.parse(inflateSync(encodeServerMessage(msg)).toString())).toEqual(msg);
  });

  it("round-trips copyText, which carries the operator's own copied text", () => {
    /*
      PLAIN JSON, NO BASE64 BRANCH: unlike `atlas`'s `coverage` and `transferData`'s `bytes`, which
      are byte arrays JSON cannot hold, this payload is already a STRING. A branch for it would be
      a third convention in `encodeServerMessage` for no reason, and the `wire` expression there
      names the two kinds that need one -- so a new one must be absent from it on purpose.

      INTERIOR SPACES ARE THE PART WORTH PINNING. `extractText` trims trailing whitespace per line
      but keeps interior runs, because those carry a panel's column alignment; a transport that
      collapsed them would make a copied column paste wrong. The double space here is that, and it
      survives `JSON.stringify` and `deflateSync` intact.
    */
    const buf = encodeServerMessage({ kind: 'copyText', text: 'HELLO  WORLD' });
    const back = JSON.parse(inflateSync(buf).toString()) as Record<string, unknown>;
    expect(back['kind']).toBe('copyText');
    expect(back['text']).toBe('HELLO  WORLD');
    // AND NOTHING ELSE, which is what says it took no base64 detour: the two kinds that do get a
    // branch in `encodeServerMessage` arrive with a field whose type CHANGED on the wire.
    expect(Object.keys(back).sort()).toEqual(['kind', 'text']);
  });

  it('round-trips a multi-line copyText, since a rectangle is usually several rows', () => {
    // NEWLINE-JOINED, which is `extractText`'s output shape for any rect taller than one row --
    // and the one character in this payload a transport could plausibly mangle.
    const msg = { kind: 'copyText' as const, text: 'ROW ONE\nROW TWO\n' };
    expect(JSON.parse(inflateSync(encodeServerMessage(msg)).toString())).toEqual(msg);
  });

  it('compresses a realistic frame by more than 20x', () => {
    // The measured figure is 237220 -> 6760 for a 24x80 screen. This asserts the PROPERTY that
    // makes full frames acceptable over a network, without pinning an exact byte count that a
    // zlib upgrade could legitimately change.
    const list = { width: 720, height: 350, cells: screenful() };
    const raw = JSON.stringify({ kind: 'frame', list });
    const enc = encodeServerMessage({ kind: 'frame', list });
    expect(raw.length / enc.length).toBeGreaterThan(20);
  });

  it('sends the atlas coverage as base64, since JSON cannot hold bytes', () => {
    const enc = encodeServerMessage({
      kind: 'atlas',
      geometry: { cellWidth: 9, cellHeight: 14, cols: 16, index: {} },
      coverage: new Uint8Array([1, 2, 250]),
      blank: [0, 1],
    });
    const back: unknown = JSON.parse(inflateSync(enc).toString());
    const obj = back as { coverage: unknown; blank: unknown };
    expect(obj.coverage).toBe(Buffer.from([1, 2, 250]).toString('base64'));
    expect(obj.blank).toEqual([0, 1]);
  });
});

describe('decodeClientMessage', () => {
  it('accepts hello with and without a session id', () => {
    expect(decodeClientMessage('{"kind":"hello"}')).toEqual({ kind: 'hello' });
    expect(decodeClientMessage('{"kind":"hello","sessionId":"abc"}'))
      .toEqual({ kind: 'hello', sessionId: 'abc' });
  });

  it('accepts an action', () => {
    expect(decodeClientMessage('{"kind":"action","action":{"kind":"enter"}}'))
      .toEqual({ kind: 'action', action: { kind: 'enter' } });
  });

  it('REFUSES a quit action, which a browser must not be able to do to the gateway', () => {
    // The bridge intercepts quit and closes its own socket. This is defense in depth, because the
    // bridge is served code and a client is not obliged to run it.
    expect(() => decodeClientMessage('{"kind":"action","action":{"kind":"quit"}}'))
      .toThrow(/quit/i);
  });

  it('accepts copy and paste, both of which it refused until 2026-10-23', () => {
    /*
      THE DECODE HALF ONLY, AND SAYING SO IS THE POINT. `applyAction` THROWS on both of these
      kinds, so this file accepting them is one branch of `protocol.ts`'s two-branch rule and is
      WORTHLESS WITHOUT THE OTHER -- the `main.ts` interception, which landed in the same commit
      and is asserted by `integration.test.ts`'s every-Action-kind case, not here. This case would
      pass just as happily against the forbidden "neither" state that ends the gateway process,
      which is why the deleted refusals above point at that case rather than at this.

      AND NEITHER KIND IS IN THAT TEST'S `SWALLOWED` LIST, which the plan for this change expected
      and the repo contradicted: a swallowed kind is one answered with SILENCE, and these two are
      both answered. `copy` replies with `copyText` -- it is the first kind whose correct reply is
      neither a frame, an error, nor silence, so that test grew an `ANSWERS` map for it -- and
      `paste` types into the screen, so its interception repaints and it replies with an ordinary
      `frame`. They left `REFUSED` without joining `SWALLOWED`.

      THE FIELDS SURVIVE THE DECODE UNCHANGED, which the two cases below then make load-bearing:
      what is accepted is a WELL-FORMED frame, and a malformed one is refused rather than passed on
      to a helper that throws on it.
    */
    const copy = decodeClientMessage(JSON.stringify({
      kind: 'action', action: { kind: 'copy', rect: { top: 0, left: 0, bottom: 1, right: 9 } },
    }));
    expect(copy).toEqual({
      kind: 'action', action: { kind: 'copy', rect: { top: 0, left: 0, bottom: 1, right: 9 } },
    });
    const paste = decodeClientMessage(JSON.stringify({
      kind: 'action', action: { kind: 'paste', text: 'ABC' },
    }));
    expect(paste).toEqual({ kind: 'action', action: { kind: 'paste', text: 'ABC' } });
    // AN EMPTY PASTE IS VALID and must stay so: it is what a paste from an empty clipboard is.
    expect(decodeClientMessage(JSON.stringify({
      kind: 'action', action: { kind: 'paste', text: '' },
    }))).toEqual({ kind: 'action', action: { kind: 'paste', text: '' } });
  });

  it('REFUSES a copy whose rect would make extractText throw IN THE SOCKET HANDLER', () => {
    /*
      THIS IS THE LINE THE PLAN FOR THIS CHANGE DID NOT HAVE, AND IT IS A PROCESS-ENDING ONE.

      MEASURED 2026-10-23, not feared. With both branches of `protocol.ts`'s two-branch rule
      correctly in place -- the rejection deleted, the `main.ts` interception added -- and no field
      check, `integration.test.ts` STILL reported `no reply to the copy action`, and with `copy`
      parked in `SWALLOWED` to expose the other half, `no reply to a tab after copy`: the session
      itself had gone. The cause is that `extractText(cells, cols, undefined)` throws
      `Cannot read properties of undefined (reading 'top')`, inside the same socket 'data' handler
      and with the same consequence as the `applyAction` throw the rule is about.

      SO THE TWO-BRANCH RULE IS NECESSARY AND NOT SUFFICIENT. It keeps a kind away from a THROWING
      `applyAction` and says nothing about the interception throwing on its own. A kind whose
      fields the honest renderer always fills is still a kind a HAND-BUILT FRAME can send empty --
      and that is not hypothetical, since `integration.test.ts` is exactly such a client by design.

      A NON-INTEGER RECT IS INCLUDED FOR A DIFFERENT REASON: it does not throw, it silently
      extracts NOTHING. MEASURED: `{top:0.5,left:0.5,bottom:1.5,right:3.5}` returns the empty
      string, so a browser bug of that shape would look to an operator like an empty selection
      rather than an error. `Number.isInteger` refuses NaN and the string "0" in the same stroke.

      THE RANGE IS DELIBERATELY NOT CHECKED, and the last case pins that: `extractText` CLAMPS to
      the grid (measured -- a `1e9` rect yields the screen, and so does an infinite one), so a
      second set of bounds here would be a second thing to keep in step with it.
    */
    const bad: readonly unknown[] = [
      undefined,                                        // no rect at all: the measured TypeError
      null,
      'x',                                              // a string has no `top`
      {},                                               // every field missing
      { top: 0, left: 0, bottom: 1 },                   // one field missing
      { top: 0, left: 0, bottom: 1.5, right: 9 },        // fractional: extracts nothing, silently
      { top: 0, left: 0, bottom: NaN, right: 9 },
      { top: 0, left: 0, bottom: '1', right: 9 },        // the string a JSON client can send
    ];
    for (const rect of bad) {
      const frame = JSON.stringify({ kind: 'action', action: { kind: 'copy', rect } });
      expect(() => decodeClientMessage(frame), `for rect ${JSON.stringify(rect)}`)
        .toThrow(/copy (needs a rect|rect )/);
    }
    // AND A HUGE RECT IS ACCEPTED, because clamping is `extractText`'s job and not this file's.
    expect(decodeClientMessage(JSON.stringify({
      kind: 'action', action: { kind: 'copy', rect: { top: 0, left: 0, bottom: 1e9, right: 1e9 } },
    })).kind).toBe('action');
  });

  it('REFUSES a paste whose text would make pasteString throw IN THE SOCKET HANDLER', () => {
    // THE SAME DEFECT AS THE `copy` CASE ABOVE, in the other direction and with its own measured
    // signature: `pasteString` does `[...text]`, which throws `text is not iterable` on a missing
    // field or a NUMBER -- and a number is something JSON carries natively and `String()` would
    // have quietly accepted. Same handler, same ended process.
    for (const text of [undefined, null, 7, [], {}, true]) {
      const frame = JSON.stringify({ kind: 'action', action: { kind: 'paste', text } });
      expect(() => decodeClientMessage(frame), `for text ${JSON.stringify(text)}`)
        .toThrow(/paste text must be a string/);
    }
  });

  /*
   * `REFUSES transferForm, and gives the FILESYSTEM as the reason rather than a missing UI` WAS
   * HERE AND IS DELETED, 2026-10-06, because its subject is gone rather than reworded. It pinned
   * the refusal's REASON -- `/filesystem/` and deliberately not `/transferForm/` -- precisely so
   * that a reason going stale would redden instead of passing on the kind's name alone. The reason
   * it pinned is now the reason the kind is ACCEPTED: socket-carried file I/O means a browser
   * transfer no longer touches the gateway's filesystem.
   *
   * DELETED RATHER THAN INVERTED because the `copy` case below already carries the discipline, and
   * `transfer messages > NO LONGER refuses the transferForm action` is its replacement. The plan
   * for this change did not mention this test at all; it was found by grep, and leaving it would
   * have made the suite assert both halves of a contradiction.
   */
  /*
   * `REFUSES copy, and gives WHOSE MACHINE as the reason rather than a missing feature` AND
   * `REFUSES paste too, because accepting it would END THE GATEWAY` WERE BOTH HERE AND ARE BOTH
   * DELETED, 2026-10-23 -- deleted rather than reworded, which is exactly what each of them said
   * should happen to it and exactly what the `transferForm` note above records happening.
   *
   * THE REASON THEY PINNED IS THE REASON THE KINDS ARE NOW ACCEPTED, which is the same inversion
   * the transfer half went through. Both pinned `/machine/` and deliberately not the kind's name,
   * because WHOSE MACHINE the text lands on is the durable objection: the gateway extracting onto
   * its own clipboard, and the gateway unable to read the operator's. A `copyText` server message
   * carrying the text back to the operator's own browser answers the first, and the browser
   * sending text it already holds answers the second. Neither refusal survives its own reason.
   *
   * WHAT REPLACES THEM IS NOT ANOTHER DECODE CASE. The `accepts copy and paste` case above pins
   * the decode half; the half that actually matters is the `main.ts` INTERCEPTION, and it is
   * `integration.test.ts`'s every-Action-kind case that asserts it -- both kinds left its
   * `REFUSED` list in this same commit. A rejection deleted without that interception is the
   * forbidden "neither" state, and the acceptance case alone could not tell the difference.
   *
   * THEY DID NOT JOIN THAT TEST'S `SWALLOWED` LIST, though the plan for this change said they
   * would: silence is the wrong answer for both. `copy` is answered with `copyText` and `paste`
   * with a `frame` from its repaint, so they left `REFUSED` for the ordinary answered path.
   *
   * THE `not.toThrow(/not implemented/)` ASSERTIONS GO WITH THEM, and their point is worth
   * keeping in view: both refusals were deliberately worded about whose machine rather than about
   * absence, so that nobody would read them as "unbuilt" and delete them while `applyAction` still
   * threw. That wording is what made these deletions safe to reason about rather than a guess.
   */

  it('refuses malformed input rather than passing it on', () => {
    // `{"kind":"action","action":{}}` is here because the `typeof aKind !== 'string'` branch was
    // otherwise VACUOUS: mutating it to `if (false)` left every test passing.
    const bads = [
      '', 'not json', '{}', '[]', '{"kind":"nope"}', '{"kind":"action"}',
      '{"kind":"action","action":{}}',
    ];
    for (const bad of bads) {
      expect(() => decodeClientMessage(bad), `for ${JSON.stringify(bad)}`).toThrow();
    }
  });

  it('accepts pf/pa numbers at both ends of core\'s AID tables', () => {
    // 1..PF_AIDS.length and 1..PA_AIDS.length -- 24 and 3 as measured, but the test reads the
    // tables so it moves with them rather than pinning literals.
    for (const n of [1, PF_AIDS.length]) {
      expect(decodeClientMessage(`{"kind":"action","action":{"kind":"pf","n":${n}}}`))
        .toEqual({ kind: 'action', action: { kind: 'pf', n } });
    }
    for (const n of [1, PA_AIDS.length]) {
      expect(decodeClientMessage(`{"kind":"action","action":{"kind":"pa","n":${n}}}`))
        .toEqual({ kind: 'action', action: { kind: 'pa', n } });
    }
  });

  it('REFUSES an out-of-range pf/pa number, which would put a bogus AID on the wire', () => {
    // `applyAction` does `PF_AIDS[action.n - 1]!`; out of range that is `undefined`, and
    // `Uint8Array.from([undefined])` in `buildReadModified` coerces to 0 -- so an unbounded `n`
    // transmits AID 0x00 to the live host and locks the keyboard. The other front ends are safe
    // only because their `n` comes from a trusted keymap.
    const bad = ['0', '-1', '1e9', '1.5', '"1"', 'null', 'true'];
    for (const kind of ['pf', 'pa'] as const) {
      const past = (kind === 'pf' ? PF_AIDS.length : PA_AIDS.length) + 1;
      for (const n of [...bad, String(past)]) {
        const text = `{"kind":"action","action":{"kind":"${kind}","n":${n}}}`;
        expect(() => decodeClientMessage(text), `for ${text}`).toThrow(/integer/i);
      }
      // A missing `n` must not sneak through as `undefined - 1` = NaN either.
      expect(() => decodeClientMessage(`{"kind":"action","action":{"kind":"${kind}"}}`))
        .toThrow(/integer/i);
    }
  });

  it('refuses a sessionId that is not a string', () => {
    expect(() => decodeClientMessage('{"kind":"hello","sessionId":42}')).toThrow();
  });
});

describe('transfer messages', () => {
  it('accepts a transferChunk with its sequence, declared total and base64 bytes', () => {
    const msg = decodeClientMessage(JSON.stringify({
      kind: 'transferChunk', seq: 0, total: 3, bytes: 'AQID',
    }));
    expect(msg.kind).toBe('transferChunk');
    if (msg.kind !== 'transferChunk') throw new Error('narrowing');
    expect(msg.seq).toBe(0);
    expect(msg.total).toBe(3);
    expect(msg.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects a transferChunk whose bytes are not a string', () => {
    expect(() => decodeClientMessage(JSON.stringify({
      kind: 'transferChunk', seq: 0, total: 3, bytes: 42,
    }))).toThrow(/bytes must be a base64 string/);
  });

  /*
   * EVERY REJECTED SHAPE OF `seq` AND `total`, AND THIS CASE EXISTS BECAUSE THE TWO ABOVE WERE NOT
   * ENOUGH. Measured 2026-10-06 by mutation: with only the non-integer `seq` case and the `bytes`
   * case, deleting `|| seq < 0` left 22/22 passing, and replacing the ENTIRE `total` guard with
   * `if (false)` also left 22/22 passing -- so two of the three validations this decode performs
   * were vacuous and the suite could not tell. A negative `seq` is the one that matters most:
   * `ChunkReassembler.accept` compares it against its own `next` counter, so a bogus value is
   * refused rather than acted on, but the decode is the boundary where untrusted numbers stop and
   * `pf`/`pa` above is this file's record of what an unchecked index did reach.
   */
  it('rejects every non-index seq and total a client can send', () => {
    for (const seq of [-1, 1.5, Number.NaN, Infinity, '0', null, true]) {
      expect(() => decodeClientMessage(JSON.stringify({
        kind: 'transferChunk', seq, total: 3, bytes: 'AQID',
      })), `for seq ${String(seq)}`).toThrow(/seq must be a non-negative integer/);
    }
    for (const total of [-1, 1.5, Number.NaN, Infinity, '3', null, true]) {
      expect(() => decodeClientMessage(JSON.stringify({
        kind: 'transferChunk', seq: 0, total, bytes: 'AQID',
      })), `for total ${String(total)}`).toThrow(/total must be a non-negative integer/);
    }
    // A MISSING FIELD IS NOT A ZERO, which `undefined` would become under a `< 0` test alone.
    expect(() => decodeClientMessage('{"kind":"transferChunk","bytes":"AQID"}'))
      .toThrow(/seq must be a non-negative integer/);
    expect(() => decodeClientMessage('{"kind":"transferChunk","seq":0,"bytes":"AQID"}'))
      .toThrow(/total must be a non-negative integer/);
  });

  it('rejects a transferChunk with a non-integer seq', () => {
    expect(() => decodeClientMessage(JSON.stringify({
      kind: 'transferChunk', seq: 1.5, total: 3, bytes: 'AQID',
    }))).toThrow(/seq must be a non-negative integer/);
  });

  it('accepts transferStart with its keyword list', () => {
    const msg = decodeClientMessage(JSON.stringify({
      kind: 'transferStart', keywords: ['Direction=send', 'LocalFile=x'],
    }));
    if (msg.kind !== 'transferStart') throw new Error('narrowing');
    expect(msg.keywords).toEqual(['Direction=send', 'LocalFile=x']);
  });

  it('rejects transferStart whose keywords are not all strings', () => {
    expect(() => decodeClientMessage(JSON.stringify({
      kind: 'transferStart', keywords: ['Direction=send', 7],
    }))).toThrow(/keywords must be an array of strings/);
  });

  it('accepts transferCancel', () => {
    expect(decodeClientMessage(JSON.stringify({ kind: 'transferCancel' })).kind)
      .toBe('transferCancel');
  });

  it('NO LONGER refuses the transferForm action', () => {
    // It was refused because a browser transfer would have written to the GATEWAY's disk.
    // Socket-carried file I/O is exactly what removes that reason.
    const msg = decodeClientMessage(JSON.stringify({
      kind: 'action', action: { kind: 'transferForm' },
    }));
    expect(msg.kind).toBe('action');
  });

  it('STILL refuses quit, which is refused for another reason', () => {
    /*
      `copy` WAS THE OTHER HALF OF THIS CASE AND IS GONE, 2026-10-23. It is now accepted, so
      asserting a throw here would have made this suite claim both halves of a contradiction --
      which is precisely the trap the deleted `transferForm` note above records, and this case was
      NOT NAMED IN THE PLAN for this change either. Found by grep for the kind, the same way that
      one was.

      `quit` STAYS, and its reason does not expire the way the other two did: it would stop the
      gateway for every connected operator, and no message travelling back to a browser changes
      that. It is the only member of `integration.test.ts`'s `REFUSED` list now.
    */
    expect(() => decodeClientMessage(JSON.stringify({
      kind: 'action', action: { kind: 'quit' },
    }))).toThrow();
  });

  it('round-trips transferProgress and transferDone as server messages', () => {
    // `inflateSync(encodeServerMessage(...))` is this suite's own idiom for a server message --
    // see its `round-trips a frame message` case. There is no decode helper and none is wanted.
    const prog = { kind: 'transferProgress' as const, text: '512 bytes' };
    expect(JSON.parse(inflateSync(encodeServerMessage(prog)).toString())).toEqual(prog);
    const done = { kind: 'transferDone' as const, ok: true, bytes: 249 };
    expect(JSON.parse(inflateSync(encodeServerMessage(done)).toString())).toEqual(done);
  });

  it('encodes transferData bytes as base64, the way the atlas message does', () => {
    const msg = {
      kind: 'transferData' as const, seq: 0, total: 3, bytes: new Uint8Array([1, 2, 3]),
    };
    const wire = JSON.parse(inflateSync(encodeServerMessage(msg)).toString());
    expect(wire.bytes).toBe('AQID');
  });
});

describe('transferDone narrows', () => {
  it('gives `error` as a string on the failure arm, with no assertion', () => {
    // THE CONVENTION THIS PINS: `{ok: boolean; error?: string}` leaves `error` as
    // `string | undefined` after `if (!m.ok)`, so every consumer needs a `!` to print the
    // message it just branched on. Two arms make the compiler do that work. The type-level
    // claim is what matters here; this case keeps it executable.
    const bad: ServerMessage = { kind: 'transferDone', ok: false, error: 'nope' };
    if (bad.kind !== 'transferDone') throw new Error('narrowing');
    const text: string = bad.ok ? 'fine' : bad.error;
    expect(text).toBe('nope');
    const good: ServerMessage = { kind: 'transferDone', ok: true, bytes: 249 };
    if (good.kind !== 'transferDone' || !good.ok) throw new Error('narrowing');
    expect(good.bytes).toBe(249);
  });
});
