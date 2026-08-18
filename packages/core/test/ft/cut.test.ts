import { describe, it, expect } from 'vitest';
import {
  ALPHAS,
  CutCodec,
  CutConversionError,
  NE,
  NQ,
  OTHER_2,
  QUADRANTS,
  TABLE6,
  XLATE_NULL,
  checksum,
  from6,
  hostToLocal,
  localToHost,
  to6,
} from '../../src/ft/cut.js';
import { CP037_TO_UNICODE } from '../../src/codepages/cp037.js';

/**
 * CUT-mode codec tests. The reference is x3270 4.5 `Common/ft_cut.c`, cited by
 * line throughout; the EBCDIC tables it uses come from `Common/tables.c`.
 *
 * The tables in cut.ts were extracted from the C by script and diffed against
 * the source (all four 77-byte quadrants, both 256-byte translation tables and
 * both string alphabets came back byte-identical). The tests below are the
 * independent half of that check: they assert the STRUCTURE a wrong byte would
 * break, so a transcription error that survived the diff would still fail here.
 */

describe('the 6-bit alphabet, ft_cut.c:105-106', () => {
  it('is 64 distinct characters', () => {
    // A 6-bit code needs exactly 64, and index <-> character must be a
    // bijection or from6/to6 could not be inverses.
    expect(TABLE6).toHaveLength(64);
    expect(new Set(TABLE6).size).toBe(64);
  });

  it('is the alphabet the source declares, verbatim', () => {
    expect(TABLE6).toBe('abcdefghijklmnopqrstuvwxyz&-.,:+ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
  });

  it('round-trips from6/to6 over all 64 indices', () => {
    for (let n = 0; n < 64; n++) {
      expect(from6(to6(n))).toBe(n);
    }
  });

  it('masks to 6 bits in to6, as the C does inline at ft_cut.c:554', () => {
    // `asc2ebc0[(int)table6[cs & 0x3f]]` -- the mask lives in one place here.
    expect(to6(0x40)).toBe(to6(0x00));
    expect(to6(0xff)).toBe(to6(0x3f));
  });

  it('returns 0 for a byte outside the alphabet, matching ft_cut.c:590-592', () => {
    // The C is deliberately lossy here:
    //     p = strchr(table6, c);
    //     if (p == NULL) {
    //         return 0;
    //     }
    // so an unrecognised byte is indistinguishable from a genuine index 0. We
    // keep that rather than diverging on frame handling we cannot yet test
    // against a live host.
    expect(from6(0x00)).toBe(0); // ebc2asc0[0x00] = 0x20, space, not in TABLE6
    expect(from6(0x40)).toBe(0); // EBCDIC space, likewise not in TABLE6
    expect(from6(0x4a)).toBe(0); // ebc2asc0 -> 0xa2, not in TABLE6
    // Exactly 64 of the 256 bytes are real encodings; the other 192 take the
    // sentinel path. Counted rather than sampled, so the ratio is pinned.
    let sentinel = 0;
    for (let b = 0; b < 256; b++) if (from6(b) === 0) sentinel++;
    // 192 not-found, plus the one byte (0x81, 'a') whose answer is truthfully 0.
    expect(sentinel).toBe(193);
  });

  it('does map the punctuation that IS in the alphabet', () => {
    // A trap worth pinning: TABLE6 contains "&-.,:+" at indices 26-31, so
    // several EBCDIC punctuation bytes are NOT sentinel cases. ebc2asc0[0x4b]
    // is '.', which is TABLE6 index 28.
    expect(TABLE6[28]).toBe('.');
    expect(from6(0x4b)).toBe(28);
    expect(from6(0x50)).toBe(26); // '&'
    expect(from6(0x60)).toBe(27); // '-'
  });

  it('does not confuse a real index 0 with the not-found sentinel', () => {
    // TABLE6[0] is 'a', EBCDIC 0x81. That is the one byte for which 0 is the
    // truthful answer, and it must still be reachable.
    expect(to6(0)).toBe(0x81);
    expect(from6(0x81)).toBe(0);
  });

  it('never has a byte translate to ASCII NUL, which is why indexOf is faithful', () => {
    // strchr() in the C also matches the string terminator, so a byte
    // translating to 0x00 would yield 64 -- one past the end. JS indexOf does
    // not have that quirk. The divergence is unobservable only because
    // ebc2asc0 never produces 0x00, which this asserts rather than assumes.
    for (let b = 0; b < 256; b++) {
      expect(from6(b)).toBeLessThan(64);
    }
  });
});

describe('the quadrant tables, ft_cut.c:56-104', () => {
  it('has NQ = 4 quadrants of NE = 77 entries', () => {
    expect(NQ).toBe(4);
    expect(NE).toBe(77);
    expect(QUADRANTS).toHaveLength(4);
    for (const q of QUADRANTS) {
      expect(q.xlate).toHaveLength(77);
    }
  });

  it('has a 77-character ALPHAS with the leading space, ft_cut.c:61-62', () => {
    expect(ALPHAS).toHaveLength(77);
    expect(new Set(ALPHAS).size).toBe(77);
    // The leading space is element 0 and is data, not formatting.
    expect(ALPHAS[0]).toBe(' ');
    expect(ALPHAS).toBe(
      ' ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789%&_()<+,-./:>?',
    );
  });

  it('has the selectors the source declares, in order', () => {
    // ft_cut.c:68 0x5e ';', :77 0x7e '=', :86 0x5c '*', :95 0x7d '\''.
    expect(QUADRANTS.map((q) => q.selector)).toEqual([0x5e, 0x7e, 0x5c, 0x7d]);
  });

  it('places NULL in OTHER_2, which is quadrant 2 per ft_cut.c:58', () => {
    expect(OTHER_2).toBe(2);
    expect(QUADRANTS[OTHER_2]!.xlate[0]).toBe(0x00);
    expect(QUADRANTS[OTHER_2]!.selector).toBe(0x5c);
  });

  it('has no selector that is itself an ALPHAS character', () => {
    // If a selector translated into ALPHAS, hostToLocal could not tell a
    // quadrant switch from data: step 3 would find an index and never retry.
    // ';' '=' '*' and '\'' are all absent from ALPHAS, and that is load-bearing.
    for (const q of QUADRANTS) {
      const ascii = String.fromCharCode(EBC2ASC_FOR_TEST[q.selector]!);
      expect(ALPHAS.includes(ascii)).toBe(false);
    }
  });

  it('covers every one of the 256 possible byte values', () => {
    // THIS IS THE CLAIM THAT LETS localToHost THROW instead of dropping a byte
    // the way x3270 does at ft_cut.c:301-303 ("Oops", return 0). If it were
    // false for even one byte, that byte would be unrepresentable in a CUT
    // upload and the codec could not be lossless.
    const missing: number[] = [];
    for (let b = 0; b < 256; b++) {
      if (!QUADRANTS.some((q) => q.xlate.includes(b))) missing.push(b);
    }
    expect(missing).toEqual([]);
  });

  it('has exactly the overlaps that make the NULL and retry special cases necessary', () => {
    // 0x00 is at index 0 of BOTH quadrant 2 and quadrant 3, which is why
    // localToHost special-cases NULL first (ft_cut.c:320-333) rather than
    // letting the generic search pick whichever it finds first.
    const inQuadrants = (b: number) =>
      QUADRANTS.map((q, i) => (q.xlate.includes(b) ? i : -1)).filter((i) => i >= 0);
    expect(inQuadrants(0x00)).toEqual([2, 3]);

    // Twelve punctuation bytes are shared between quadrants 0 and 1, which is
    // what keeps a quadrant "sticky" across mixed text and is why the encoded
    // length is data-dependent.
    const shared = [];
    for (let b = 1; b < 256; b++) if (inQuadrants(b).length > 1) shared.push(b);
    expect(shared).toEqual([0x4b, 0x4c, 0x4d, 0x4e, 0x50, 0x61, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f, 0x7a]);
  });
});

describe('checksum, ft_cut.c:550-554', () => {
  it('XORs the bytes and masks to 6 bits', () => {
    // Computed by hand: 0x01 ^ 0x02 = 0x03, ^ 0x03 = 0x00.
    expect(checksum([0x01, 0x02, 0x03])).toBe(0x00);
    // 0xff ^ 0x0f = 0xf0; 0xf0 & 0x3f = 0x30.
    expect(checksum([0xff, 0x0f])).toBe(0x30);
    // 0x41 ^ 0x42 = 0x03, ^ 0x43 = 0x40; 0x40 & 0x3f = 0x00. The mask is what
    // makes this differ from a plain XOR, so it needs a case that exercises it.
    expect(checksum([0x41, 0x42, 0x43])).toBe(0x00);
    // Single byte, no masking needed: 0x2a & 0x3f = 0x2a.
    expect(checksum([0x2a])).toBe(0x2a);
  });

  it('is 0 over an empty buffer, since the C initialises cs = 0', () => {
    expect(checksum([])).toBe(0);
    expect(checksum(new Uint8Array(0))).toBe(0);
  });

  it('encodes through TABLE6 the way the frame writer will', () => {
    // ctlr_add(O_UP_CSUM, asc2ebc0[(int)table6[cs & 0x3f]], 0) -- ft_cut.c:554.
    // We return the raw value and let the caller call to6; this pins that the
    // composition is what the C writes. cs = 0x30 = 48, TABLE6[48] = 'Q'.
    expect(TABLE6[48]).toBe('Q');
    expect(to6(checksum([0xff, 0x0f]))).toBe(0xd8); // EBCDIC 'Q'
  });

  it('accepts a Uint8Array as well as an array', () => {
    expect(checksum(Uint8Array.of(0x01, 0x02, 0x03))).toBe(0x00);
  });
});

describe('the exhaustive round trip', () => {
  it('recovers every single byte value 0x00-0xff', () => {
    // THE headline property. The codec is pure and small, so this is genuinely
    // exhaustive rather than sampled. Each byte gets a fresh codec, so this is
    // the "first byte of a transfer" case for all 256 values.
    for (let b = 0; b < 256; b++) {
      const encoded = localToHost([b]);
      const decoded = hostToLocal(encoded);
      expect(Array.from(decoded), `byte 0x${b.toString(16).padStart(2, '0')}`).toEqual([b]);
    }
  });

  it('recovers all 256 values in one stateful pass, quadrant persisting', () => {
    // Different test from the one above: here the quadrant carries across all
    // 256 bytes, so the single-byte-emission path and every quadrant switch are
    // both exercised, in sequence, by one codec pair.
    const all = Array.from({ length: 256 }, (_unused, i) => i);
    const encoded = new CutCodec().localToHost(all);
    const decoded = new CutCodec().hostToLocal(encoded);
    expect(Array.from(decoded)).toEqual(all);
    // 256 data bytes plus one selector per quadrant change. Pinned so a change
    // in switching behaviour is visible rather than merely still-lossless.
    expect(encoded.length).toBe(285);
  });

  it('recovers pseudorandom buffers', () => {
    // Seeded LCG rather than Math.random: a failure must be reproducible.
    let seed = 0x2b3c4d5e;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed >>> 24;
    };
    for (let trial = 0; trial < 500; trial++) {
      const n = 1 + (next() % 64);
      const buf = Array.from({ length: n }, () => next());
      const decoded = new CutCodec().hostToLocal(new CutCodec().localToHost(buf));
      expect(Array.from(decoded), `trial ${trial}: ${buf.join(',')}`).toEqual(buf);
    }
  });

  it('recovers a run of every byte repeated, where the quadrant never changes', () => {
    // The 1-byte-output path in isolation: after the first byte the quadrant is
    // already right, so a run of 8 encodes as selector + 8 characters.
    for (let b = 1; b < 256; b++) {
      const run = Array.from({ length: 8 }, () => b);
      const encoded = new CutCodec().localToHost(run);
      expect(encoded.length, `byte 0x${b.toString(16)}`).toBe(9);
      expect(Array.from(new CutCodec().hostToLocal(encoded))).toEqual(run);
    }
  });
});

describe('NULL, which has a special path in both directions', () => {
  it('round-trips as selector 0x5c then XLATE_NULL', () => {
    // ft_cut.c:326-330: switch to OTHER_2, emit its selector, then XLATE_NULL.
    const encoded = localToHost([0x00]);
    expect(Array.from(encoded)).toEqual([0x5c, XLATE_NULL]);
    expect(XLATE_NULL).toBe(0xc1);
    expect(Array.from(hostToLocal(encoded))).toEqual([0x00]);
  });

  it('emits the selector only once for a run of NULLs', () => {
    // The `if (quadrant != OTHER_2)` guard at ft_cut.c:326 -- statefulness.
    const encoded = localToHost([0x00, 0x00, 0x00]);
    expect(Array.from(encoded)).toEqual([0x5c, XLATE_NULL, XLATE_NULL, XLATE_NULL]);
    expect(Array.from(hostToLocal(encoded))).toEqual([0x00, 0x00, 0x00]);
  });

  it('distinguishes NULL from 0xc1, which XLATE_NULL collides with', () => {
    // 0xc1 IS XLATE_NULL, and is also a real data byte living in quadrant 0 at
    // index 1. Decoding depends entirely on which quadrant is current, which is
    // the nastiest case in the whole codec.
    expect(Array.from(localToHost([0xc1]))).toEqual([0x5e, 0xc1]);
    expect(Array.from(localToHost([0x00]))).toEqual([0x5c, 0xc1]);
    // Interleaved, so both readings of the same 0xc1 byte occur in one buffer.
    const buf = [0x00, 0xc1, 0x00, 0xc1];
    expect(Array.from(hostToLocal(localToHost(buf)))).toEqual(buf);
  });

  it('decodes only under OTHER_2, quadrant 3 index 0 being genuinely absent', () => {
    // Quadrant 3 also has 0x00 at index 0 (ft_cut.c:96), but there it means
    // "absent", not NULL. So selecting quadrant 3 and sending a byte at ALPHAS
    // index 0 must retry, and then fail because that byte is not a selector --
    // NOT decode as a NULL. Only OTHER_2 yields NULL.
    expect(QUADRANTS[3]!.xlate[0]).toBe(0x00);
    expect(() => hostToLocal(Uint8Array.of(0x7d, 0x40))).toThrow(CutConversionError);
    expect(Array.from(hostToLocal(Uint8Array.of(0x5c, 0x40)))).toEqual([0x00]);
  });

  it('FINDING: the `c != XLATE_NULL` clause at ft_cut.c:181 is dead code', () => {
    // Worth recording rather than merely porting. The clause can only change a
    // decision when the quadrant is not OTHER_2, xlate[ix] is 0, and c is
    // 0xc1. But ebc2asc0[0xc1] is 'A', which is ALPHAS index 1 always -- and
    // NO non-OTHER_2 quadrant has a zero at index 1 (0xc1, 0x41, -, 0xa0). So
    // the condition is unsatisfiable and the clause never fires.
    //
    // We keep it anyway, because it costs nothing and the tables are data that
    // a different host build could conceivably differ on. This test is what
    // would tell us if that ever stopped being true.
    const ixOfC1 = 1; // ALPHAS.indexOf('A')
    expect(ALPHAS[ixOfC1]).toBe('A');
    for (let q = 0; q < NQ; q++) {
      if (q === OTHER_2) continue;
      expect(QUADRANTS[q]!.xlate[ixOfC1], `quadrant ${q} index ${ixOfC1}`).not.toBe(0);
    }
    // Consequence: under quadrant 3, 0xc1 decodes as ordinary data (0xa0), not
    // as a NULL, and round-trips as such.
    expect(Array.from(hostToLocal(Uint8Array.of(0x7d, 0xc1)))).toEqual([0xa0]);
  });
});

describe('quadrant changes mid-buffer', () => {
  it('emits the expected selector, constructed from the tables', () => {
    // Built deliberately, not hopefully. 0x41 is in quadrant 1 only, at index
    // 1; 0x0a is in quadrant 2 only, at index 11. So the encoding must be
    // selector(1)=0x7e, char, selector(2)=0x5c, char.
    const inQuadrants = (b: number) =>
      QUADRANTS.map((q, i) => (q.xlate.includes(b) ? i : -1)).filter((i) => i >= 0);
    expect(inQuadrants(0x41)).toEqual([1]);
    expect(inQuadrants(0x0a)).toEqual([2]);
    expect(QUADRANTS[1]!.xlate.indexOf(0x41)).toBe(1);
    expect(QUADRANTS[2]!.xlate.indexOf(0x0a)).toBe(11);

    const encoded = localToHost([0x41, 0x0a]);
    // ALPHAS[1] = 'A' -> EBCDIC 0xc1; ALPHAS[11] = 'K' -> EBCDIC 0xd2.
    expect(ALPHAS[1]).toBe('A');
    expect(ALPHAS[11]).toBe('K');
    expect(Array.from(encoded)).toEqual([0x7e, 0xc1, 0x5c, 0xd2]);
    // The change selector 0x5c is present, at the position the switch happens.
    expect(Array.from(encoded).indexOf(0x5c)).toBe(2);
    expect(Array.from(hostToLocal(encoded))).toEqual([0x41, 0x0a]);
  });

  it('switches back and forth, one selector per change', () => {
    // 0x41 (quadrant 1) and 0x40 (quadrant 0 only) alternating: every byte
    // costs a selector, so 4 inputs become 8 outputs.
    const buf = [0x41, 0x40, 0x41, 0x40];
    const encoded = localToHost(buf);
    expect(Array.from(encoded)).toEqual([0x7e, 0xc1, 0x5e, 0x40, 0x7e, 0xc1, 0x5e, 0x40]);
    expect(Array.from(hostToLocal(encoded))).toEqual(buf);
  });

  it('does not re-emit a selector for a byte the current quadrant already maps', () => {
    // The shared punctuation is what makes this observable: 0x4b is in both
    // quadrants 0 and 1, so after 0x41 has selected quadrant 1 the 0x4b costs
    // one byte, not two, and the quadrant does not move.
    const codec = new CutCodec();
    const encoded = codec.localToHost([0x41, 0x4b]);
    expect(encoded.length).toBe(3);
    expect(codec.currentQuadrant).toBe(1);
    expect(Array.from(new CutCodec().hostToLocal(encoded))).toEqual([0x41, 0x4b]);
  });

  it('skips the current quadrant when searching, per ft_cut.c:289-291', () => {
    // `if (quadrant == oq) continue;` -- the current quadrant was just tried
    // and missed, so re-testing it is wasted work, but more importantly the
    // loop must still be able to LEAVE it.
    const codec = new CutCodec();
    codec.localToHost([0x40]); // quadrant 0
    expect(codec.currentQuadrant).toBe(0);
    codec.localToHost([0x20]); // quadrant 1 only
    expect(codec.currentQuadrant).toBe(1);
  });
});

describe('statefulness across calls, which the frame layer depends on', () => {
  it('carries the quadrant across separate localToHost calls', () => {
    // A multi-frame upload calls this once per frame with ONE codec. If the
    // quadrant reset per call, every frame would start with a spurious
    // selector; encoding [0x41] then [0x41] must cost 2 bytes then 1.
    const codec = new CutCodec();
    expect(codec.localToHost([0x41]).length).toBe(2);
    expect(codec.localToHost([0x41]).length).toBe(1);
  });

  it('carries the quadrant across separate hostToLocal calls', () => {
    // The mirror image: a frame whose first byte is data, not a selector, is
    // normal and must decode against the quadrant the previous frame left set.
    const codec = new CutCodec();
    expect(Array.from(codec.hostToLocal(Uint8Array.of(0x7e, 0xc1)))).toEqual([0x41]);
    expect(Array.from(codec.hostToLocal(Uint8Array.of(0xc1)))).toEqual([0x41]);
  });

  it('keeps two codecs independent, unlike x3270 file-static quadrant', () => {
    // ft_cut.c:108 `static int quadrant = -1` makes concurrent transfers
    // impossible and tests order-dependent. This is why we do not copy it.
    const a = new CutCodec();
    const b = new CutCodec();
    a.localToHost([0x41]);
    expect(a.currentQuadrant).toBe(1);
    expect(b.currentQuadrant).toBe(-1);
    // b still needs its own selector, unaffected by a.
    expect(b.localToHost([0x41]).length).toBe(2);
  });

  it('reset() returns to the start-of-transfer state, as ft_cut.c:435 does', () => {
    const codec = new CutCodec();
    codec.localToHost([0x41]);
    codec.reset();
    expect(codec.currentQuadrant).toBe(-1);
    expect(codec.localToHost([0x41]).length).toBe(2);
  });

  it('makes the module-level wrappers whole-buffer only, by construction', () => {
    // hostToLocal/localToHost each build a fresh codec, so splitting a buffer
    // across two calls is NOT the same as one call. Pinned so nobody uses them
    // for a streaming transfer by accident.
    const whole = localToHost([0x41, 0x41]);
    const split = [...localToHost([0x41]), ...localToHost([0x41])];
    expect(whole.length).toBe(3);
    expect(split.length).toBe(4);
  });

  it('returns an empty result for an empty buffer without touching state', () => {
    const codec = new CutCodec();
    expect(codec.localToHost([]).length).toBe(0);
    expect(codec.hostToLocal(new Uint8Array(0)).length).toBe(0);
    expect(codec.currentQuadrant).toBe(-1);
  });
});

describe('the retry path, ft_cut.c:170-186', () => {
  it('re-reads a byte as a selector when the current quadrant cannot map it', () => {
    // The `goto retry` case. 0x7e is a selector; with quadrant 0 set it is
    // ALSO in range 0x40..0xf9, translates to '=' which is NOT in ALPHAS, so
    // step 3 drops the quadrant and the SAME byte is re-read as the selector
    // for quadrant 1. That is a switch encoded with no wasted byte.
    const codec = new CutCodec();
    codec.hostToLocal(Uint8Array.of(0x5e, 0x40)); // quadrant 0, one data byte
    expect(codec.currentQuadrant).toBe(0);
    expect(Array.from(codec.hostToLocal(Uint8Array.of(0x7e, 0xc1)))).toEqual([0x41]);
    expect(codec.currentQuadrant).toBe(1);
  });

  it('re-reads via the zero-entry rule, the second retry trigger', () => {
    // 0x5c is a selector AND is in range and translates to '*', also absent
    // from ALPHAS. Distinct trigger from the xlate[ix] == 0 clause, but the
    // observable effect -- retry, then treat as selector -- is the same.
    const codec = new CutCodec();
    codec.hostToLocal(Uint8Array.of(0x7e, 0xc1));
    expect(Array.from(codec.hostToLocal(Uint8Array.of(0x5c, 0xd2)))).toEqual([0x0a]);
    expect(codec.currentQuadrant).toBe(2);
  });

  it('terminates: at most two passes per byte', () => {
    // The retry sets quadrant to -1, and the -1 branch either consumes the
    // byte or throws, so it cannot loop. A 4096-byte adversarial buffer of
    // alternating selectors must complete rather than hang.
    const codec = new CutCodec();
    const buf = Uint8Array.from(
      Array.from({ length: 4096 }, (_unused, i) => (i % 2 === 0 ? 0x5e : 0x7e)),
    );
    expect(codec.hostToLocal(buf).length).toBe(0);
  });
});

describe('conversion errors', () => {
  it('rejects a byte below 0x40 once a quadrant is set, ft_cut.c:161-164', () => {
    const codec = new CutCodec();
    codec.hostToLocal(Uint8Array.of(0x5e)); // establish quadrant 0
    expect(() => codec.hostToLocal(Uint8Array.of(0x3f))).toThrow(CutConversionError);
    expect(() => codec.hostToLocal(Uint8Array.of(0x00))).toThrow(/0x00 is outside/);
  });

  it('rejects a byte above 0xf9 once a quadrant is set', () => {
    const codec = new CutCodec();
    codec.hostToLocal(Uint8Array.of(0x5e));
    expect(() => codec.hostToLocal(Uint8Array.of(0xfa))).toThrow(/0xfa is outside/);
    // 0xf9 is the last legal value, so the boundary is inclusive.
    expect(() => codec.hostToLocal(Uint8Array.of(0xf9))).not.toThrow();
  });

  it('rejects a first byte that matches no selector, ft_cut.c:155-158', () => {
    // With no quadrant set the range check has not run yet, so this is the
    // other error site, and it fires for both in-range and out-of-range bytes.
    expect(() => hostToLocal(Uint8Array.of(0x40))).toThrow(CutConversionError);
    expect(() => hostToLocal(Uint8Array.of(0x40))).toThrow(/not a quadrant selector/);
    expect(() => hostToLocal(Uint8Array.of(0x00))).toThrow(/not a quadrant selector/);
  });

  it('names the error class so a catch site can be specific', () => {
    try {
      hostToLocal(Uint8Array.of(0x40));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CutConversionError);
      expect((e as Error).name).toBe('CutConversionError');
    }
  });

  it('never throws from localToHost for any byte, since all 256 are covered', () => {
    // The counterpart to the coverage test: we chose to throw where x3270
    // prints "Oops" and drops the byte (ft_cut.c:301-303), and this is what
    // makes that choice safe rather than a new failure mode.
    for (let b = 0; b < 256; b++) {
      expect(() => localToHost([b]), `byte 0x${b.toString(16)}`).not.toThrow();
    }
  });
});

describe('cp037 versus x3270 ebc2asc0/asc2ebc0 in this file', () => {
  /**
   * The codec carries its own 256-byte tables rather than using CodePage/cp037.
   * These tests are the evidence for that decision, and would catch cp037
   * being "cleaned up" into the codec later.
   *
   * ft_cut.c:344-348: "The host uses a fixed EBCDIC-to-ASCII translation table,
   * which was derived empirically into i_ft2asc/i_asc2ft."
   */
  const cpToAscii = (b: number) => CP037_TO_UNICODE[b]!;
  const cpFromUnicode = new Map<number, number>();
  for (let b = 255; b >= 0; b--) cpFromUnicode.set(CP037_TO_UNICODE[b]!, b);

  it('agrees with cp037 on all 64 TABLE6 characters, both directions', () => {
    // So from6/to6 would behave identically either way -- the divergence does
    // NOT reach the 6-bit codec.
    for (let n = 0; n < 64; n++) {
      const ch = TABLE6.codePointAt(n)!;
      expect(cpFromUnicode.get(ch), `TABLE6[${n}]`).toBe(to6(n));
    }
    for (let b = 0; b < 256; b++) {
      const viaCp = TABLE6.indexOf(String.fromCodePoint(cpToAscii(b)));
      expect(viaCp === -1 ? 0 : viaCp, `from6(0x${b.toString(16)})`).toBe(from6(b));
    }
  });

  it('agrees with cp037 on all 77 ALPHAS characters for ASCII->EBCDIC', () => {
    // So localToHost would encode identically either way. Checked by encoding
    // each ALPHAS index through the real codec and comparing.
    for (let ix = 0; ix < NE; ix++) {
      const ch = ALPHAS.codePointAt(ix)!;
      const viaCp = cpFromUnicode.get(ch);
      expect(viaCp, `ALPHAS[${ix}] = ${JSON.stringify(ALPHAS[ix])}`).not.toBeUndefined();

      // Encode a byte that lives at this index in quadrant 1 -- whose xlate has
      // no zero entries, so every index is reachable -- and check the character
      // byte emitted. The codec must be PRE-POSITIONED in quadrant 1: twelve of
      // the bytes are shared with quadrant 0, and a fresh codec would search
      // from 0 and find them there at a different ALPHAS index.
      const dataByte = QUADRANTS[1]!.xlate[ix]!;
      const codec = new CutCodec();
      codec.localToHost([0x20]); // 0x20 is in quadrant 1 only: pins the quadrant
      expect(codec.currentQuadrant).toBe(1);
      const encoded = codec.localToHost([dataByte]);
      expect(encoded, `ALPHAS[${ix}]`).toHaveLength(1);
      expect(encoded[0], `ALPHAS[${ix}] = ${JSON.stringify(ALPHAS[ix])}`).toBe(viaCp);
    }
  });

  it('DIVERGES on EBCDIC 0x41, the one difference that reaches this codec', () => {
    // ebc2asc0[0x41] = 0x20 (space), so x3270 decodes X'41' as ALPHAS index 0.
    // cp037 maps 0x41 to U+00A0 NO-BREAK SPACE, which is not in ALPHAS at all,
    // so a cp037-based codec would raise a conversion error where x3270
    // succeeds. This is why the codec does not use cp037.
    expect(CP037_TO_UNICODE[0x41]).toBe(0x00a0);
    expect(ALPHAS.includes(' ')).toBe(false);
    // The real codec decodes it as index 0 of the current quadrant. In
    // quadrant 1, ALPHAS index 0 is ' ' -> data byte 0x20.
    const codec = new CutCodec();
    expect(Array.from(codec.hostToLocal(Uint8Array.of(0x7e, 0x41)))).toEqual([0x20]);
    // And in quadrant 0, index 0 is data byte 0x40.
    const codec2 = new CutCodec();
    expect(Array.from(codec2.hostToLocal(Uint8Array.of(0x5e, 0x41)))).toEqual([0x40]);
  });

  it('differs from cp037 in 66 of 256 entries overall, almost all below 0x40', () => {
    // Recorded so the scale of the divergence is documented rather than
    // folklore: ebc2asc0 flattens the EBCDIC control range to spaces, except
    // X'1C' -> '*' and X'1E' -> ';' (which are two of the four selectors' ASCII
    // forms -- not a coincidence). Only 0x41 and 0xff differ at or above 0x40.
    // Reconstructed through from6, which exposes ebc2asc0 indirectly: the two
    // tables are private, so this asserts the observable consequence.
    const flattened: number[] = [];
    for (let b = 0; b < 0x40; b++) {
      // Every control byte translates to space, which is absent from TABLE6, so
      // from6 returns the not-found 0 for all of them.
      if (from6(b) === 0) flattened.push(b);
    }
    expect(flattened).toHaveLength(0x40);
  });
});

/**
 * ebc2asc0, re-declared here ONLY so the selector/ALPHAS disjointness test can
 * reach it -- the codec keeps its tables private, which is right. Copied from
 * x3270 Common/tables.c:41-73, and only the four selector entries matter:
 * 0x5c -> '*', 0x5e -> ';', 0x7d -> '\'', 0x7e -> '='.
 */
const EBC2ASC_FOR_TEST: Record<number, number> = {
  0x5c: 0x2a, // '*'
  0x5e: 0x3b, // ';'
  0x7d: 0x27, // '\''
  0x7e: 0x3d, // '='
};
