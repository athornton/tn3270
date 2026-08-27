import { describe, it, expect } from 'vitest';
import { TelnetLayer, MAX_RECORD_BYTES, MAX_SUBNEG_BYTES } from '../src/telnet.js';
import { TelnetCmd as T, TelnetOpt as O, TelnetSubopt as S } from '../src/constants.js';
import { Trace } from '../src/trace.js';

/** Collects what the layer wants to transmit and the records it produces. */
function harness() {
  const sent: number[][] = [];
  const records: Uint8Array[] = [];
  const layer = new TelnetLayer({
    write: (b) => sent.push(Array.from(b)),
    onRecord: (r) => records.push(r),
  });
  return { layer, sent, records };
}

/** As `harness`, with an explicit terminal type. */
function harness2(terminalType: string) {
  const sent: number[][] = [];
  const records: Uint8Array[] = [];
  const layer = new TelnetLayer({
    write: (b) => sent.push(Array.from(b)),
    onRecord: (r) => records.push(r),
    terminalType,
  });
  return { layer, sent, records };
}

describe('option negotiation', () => {
  it('agrees to the three options that make a session TN3270', () => {
    const { layer, sent } = harness();
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TERMINAL_TYPE));
    expect(sent[0]).toEqual([T.IAC, T.WILL, O.TERMINAL_TYPE]);
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.EOR));
    expect(sent[1]).toEqual([T.IAC, T.WILL, O.EOR]);
    layer.receive(Uint8Array.of(T.IAC, T.WILL, O.EOR));
    expect(sent[2]).toEqual([T.IAC, T.DO, O.EOR]);
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.BINARY));
    expect(sent[3]).toEqual([T.IAC, T.WILL, O.BINARY]);
    layer.receive(Uint8Array.of(T.IAC, T.WILL, O.BINARY));
    expect(sent[4]).toEqual([T.IAC, T.DO, O.BINARY]);
  });

  it('reports 3270 mode only once binary and EOR are agreed both ways', () => {
    const { layer } = harness();
    expect(layer.is3270Mode()).toBe(false);
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TERMINAL_TYPE));
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.EOR, T.IAC, T.WILL, O.EOR));
    expect(layer.is3270Mode()).toBe(false);
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.BINARY, T.IAC, T.WILL, O.BINARY));
    expect(layer.is3270Mode()).toBe(true);
  });

  it('answers a terminal-type query with IBM-3278-2 in ASCII', () => {
    const { layer, sent } = harness();
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TERMINAL_TYPE));
    sent.length = 0;
    layer.receive(Uint8Array.of(T.IAC, T.SB, O.TERMINAL_TYPE, S.SEND, T.IAC, T.SE));
    const expected = [
      T.IAC, T.SB, O.TERMINAL_TYPE, S.IS,
      ...Array.from('IBM-3278-2', (c) => c.charCodeAt(0)),
      T.IAC, T.SE,
    ];
    expect(sent[0]).toEqual(expected);
  });

  it('advertises an ASCII-only terminal type', () => {
    const { layer, sent } = harness();
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TERMINAL_TYPE));
    sent.length = 0;
    layer.receive(Uint8Array.of(T.IAC, T.SB, O.TERMINAL_TYPE, S.SEND, T.IAC, T.SE));
    const payload = sent[0]!.slice(4, -2);
    for (const code of payload) {
      expect(code).toBeGreaterThanOrEqual(0x20);
      expect(code).toBeLessThanOrEqual(0x7e);
    }
    expect(String.fromCharCode(...payload)).toBe('IBM-3278-2');
  });

  it('doubles an IAC inside the terminal-type body but not the framing', () => {
    // RFC 855 (option specifications), final paragraph: "Finally, if parameters
    // in an option "subnegotiation" include a byte with a value of 255, it is
    // necessary to double this byte in accordance the general TELNET rules."
    // x3270 implements exactly this for the ttype reply: the reply is built with
    // its own IAC SB / IAC SE already in the buffer and handed to
    // net_hexnvt_out_framed(..., true) (telnet.c:2025), which skips quoting the
    // first byte and the last two — telnet.c:3003-3004,
    //     if (framed && (first || len == 1)) {
    //         /* Don't quote initial IAC or trailing IAC SE. */
    // Only reachable via the raw --terminal-type escape hatch; -model produces
    // ASCII only. It is a correctness fix, not an urgent one.
    const { layer, sent } = harness2('A\xffB');
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TERMINAL_TYPE));
    sent.length = 0;
    layer.receive(Uint8Array.of(T.IAC, T.SB, O.TERMINAL_TYPE, S.SEND, T.IAC, T.SE));
    expect(sent[0]).toEqual([
      T.IAC, T.SB, O.TERMINAL_TYPE, S.IS,
      0x41, T.IAC, T.IAC, 0x42, // the interior 0xff is doubled
      T.IAC, T.SE,              // ...but the trailing framing is not
    ]);
  });

  it('doubles a ttype IAC that only appears after truncation to a byte', () => {
    // The name is built with charCodeAt, which yields a UTF-16 code unit, and
    // Uint8Array.from then truncates it mod 256 *silently*. U+01FF is 511, which
    // is not 0xff but truncates to 0xff, so a doubling test applied to the
    // untruncated value would emit a bare IAC. The mask must come first.
    const { layer, sent } = harness2('ǿ');
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TERMINAL_TYPE));
    sent.length = 0;
    layer.receive(Uint8Array.of(T.IAC, T.SB, O.TERMINAL_TYPE, S.SEND, T.IAC, T.SE));
    expect(sent[0]).toEqual([
      T.IAC, T.SB, O.TERMINAL_TYPE, S.IS, T.IAC, T.IAC, T.IAC, T.SE,
    ]);
  });

  it('ACCEPTS TN3270E by default, which stage 1 did not', () => {
    // THIS ASSERTION WAS INVERTED BY STAGE 2b, deliberately. It read
    // `[T.IAC, T.WONT, O.TN3270E]` and was named "refuses TN3270E in stage 1",
    // pinning a limitation rather than a decision: option 40 fell through onDo's
    // catch-all because nothing implemented it.
    //
    // TN3270E is now offered by default, matching x3270, and that is safe because
    // the negotiation can back off to traditional tn3270 on a reject. The refusal
    // path still exists and still has a test -- see "answers DO TN3270E with WONT
    // when disabled", which is what -tn3270e off and the N: prefix produce.
    const { layer, sent } = harness();
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TN3270E));
    expect(sent[0]).toEqual([T.IAC, T.WILL, O.TN3270E]);
  });

  it('refuses 3270-REGIME and TIMING-MARK, accepts SUPPRESS-GO-AHEAD', () => {
    const { layer, sent } = harness();
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.REGIME_3270));
    expect(sent[0]).toEqual([T.IAC, T.WONT, O.REGIME_3270]);
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TIMING_MARK));
    expect(sent[1]).toEqual([T.IAC, T.WONT, O.TIMING_MARK]);
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.SUPPRESS_GO_AHEAD));
    expect(sent[2]).toEqual([T.IAC, T.WILL, O.SUPPRESS_GO_AHEAD]);
  });

  it('ignores IAC NOP without replying', () => {
    const { layer, sent, records } = harness();
    layer.receive(Uint8Array.of(T.IAC, T.NOP));
    expect(sent).toEqual([]);
    expect(records).toEqual([]);
  });

  it('does not re-acknowledge an option it already agreed to', () => {
    const { layer, sent } = harness();
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.EOR));
    expect(sent).toHaveLength(1);
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.EOR));
    expect(sent).toHaveLength(1);
  });

  it('refuses an unknown option', () => {
    const { layer, sent } = harness();
    layer.receive(Uint8Array.of(T.IAC, T.DO, 99));
    expect(sent[0]).toEqual([T.IAC, T.WONT, 99]);
    layer.receive(Uint8Array.of(T.IAC, T.WILL, 99));
    expect(sent[1]).toEqual([T.IAC, T.DONT, 99]);
  });

  it('drops out of 3270 mode when the host DONTs BINARY', () => {
    const { layer } = harness();
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.EOR, T.IAC, T.WILL, O.EOR));
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.BINARY, T.IAC, T.WILL, O.BINARY));
    expect(layer.is3270Mode()).toBe(true);
    layer.receive(Uint8Array.of(T.IAC, T.DONT, O.BINARY));
    expect(layer.is3270Mode()).toBe(false);
  });

  it('accepts IAC WONT for an option we offered and drops it from hisOpts', () => {
    const { layer, sent } = harness();
    layer.receive(Uint8Array.of(T.IAC, T.WILL, O.EOR));
    expect(sent[0]).toEqual([T.IAC, T.DO, O.EOR]);
    layer.receive(Uint8Array.of(T.IAC, T.WONT, O.EOR));
    expect(sent[1]).toEqual([T.IAC, T.DONT, O.EOR]);
    expect(layer.is3270Mode()).toBe(false);
  });
});

describe('record framing', () => {
  function in3270() {
    const h = harness();
    h.layer.receive(Uint8Array.of(T.IAC, T.DO, O.EOR, T.IAC, T.WILL, O.EOR));
    h.layer.receive(Uint8Array.of(T.IAC, T.DO, O.BINARY, T.IAC, T.WILL, O.BINARY));
    h.sent.length = 0;
    return h;
  }

  it('delivers a record at IAC EOR', () => {
    const { layer, records } = in3270();
    layer.receive(Uint8Array.of(0xf5, 0xc3, 0x11, 0x40, 0x40, T.IAC, T.EOR));
    expect(records).toHaveLength(1);
    expect(Array.from(records[0]!)).toEqual([0xf5, 0xc3, 0x11, 0x40, 0x40]);
  });

  it('reassembles a record split across three chunks', () => {
    const { layer, records } = in3270();
    layer.receive(Uint8Array.of(0xf5, 0xc3));
    expect(records).toHaveLength(0);
    layer.receive(Uint8Array.of(0x11, 0x40));
    expect(records).toHaveLength(0);
    layer.receive(Uint8Array.of(0x40, T.IAC, T.EOR));
    expect(records).toHaveLength(1);
    expect(Array.from(records[0]!)).toEqual([0xf5, 0xc3, 0x11, 0x40, 0x40]);
  });

  it('survives a chunk boundary between IAC and EOR', () => {
    const { layer, records } = in3270();
    layer.receive(Uint8Array.of(0xf5, T.IAC));
    expect(records).toHaveLength(0);
    layer.receive(Uint8Array.of(T.EOR));
    expect(records).toHaveLength(1);
    expect(Array.from(records[0]!)).toEqual([0xf5]);
  });

  it('unescapes IAC IAC to a single 0xFF inside field data', () => {
    const { layer, records } = in3270();
    layer.receive(Uint8Array.of(0xf5, T.IAC, T.IAC, 0xc3, T.IAC, T.EOR));
    expect(Array.from(records[0]!)).toEqual([0xf5, 0xff, 0xc3]);
  });

  it('handles negotiation interleaved mid-record', () => {
    const { layer, records, sent } = in3270();
    layer.receive(Uint8Array.of(0xf5, T.IAC, T.DO, O.SUPPRESS_GO_AHEAD, 0xc3, T.IAC, T.EOR));
    expect(sent[0]).toEqual([T.IAC, T.WILL, O.SUPPRESS_GO_AHEAD]);
    expect(Array.from(records[0]!)).toEqual([0xf5, 0xc3]);
  });

  it('delivers two records from one chunk', () => {
    const { layer, records } = in3270();
    layer.receive(Uint8Array.of(0xf5, T.IAC, T.EOR, 0xf1, T.IAC, T.EOR));
    expect(records).toHaveLength(2);
    expect(Array.from(records[0]!)).toEqual([0xf5]);
    expect(Array.from(records[1]!)).toEqual([0xf1]);
  });

  it('does not deliver an empty record', () => {
    const { layer, records } = in3270();
    layer.receive(Uint8Array.of(T.IAC, T.EOR));
    expect(records).toHaveLength(0);
  });

  it('drops a subnegotiation it does not understand', () => {
    const { layer, records } = in3270();
    layer.receive(Uint8Array.of(T.IAC, T.SB, 77, 1, 2, 3, T.IAC, T.SE, 0xf5, T.IAC, T.EOR));
    expect(Array.from(records[0]!)).toEqual([0xf5]);
  });

  it('notes an empty subnegotiation as such instead of a fabricated option number', () => {
    const trace = new Trace({ enabled: true, clock: () => 0 });
    const layer = new TelnetLayer({ write: () => {}, onRecord: () => {}, trace });
    layer.receive(Uint8Array.of(T.IAC, T.SB, T.IAC, T.SE));
    expect(trace.lines()).toContain('0.000 = # ignored subnegotiation for option (empty)');
  });

  it('does not leak an NVT logon banner into the first 3270 record', () => {
    // THE regression test for this module. Hosts print a banner or a session
    // manager prompt before going 3270 — VM/ESA, TSO behind a session manager,
    // most Hercules configurations. Those bytes must never reach the record
    // accumulator, or the parser reads a banner character as the command byte.
    const { layer, records } = harness();
    const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TERMINAL_TYPE));
    layer.receive(ascii('Enter terminal type: '));
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.ECHO));
    layer.receive(ascii('\r\nVM/ESA ONLINE\r\n'));
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.EOR, T.IAC, T.WILL, O.EOR));
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.BINARY, T.IAC, T.WILL, O.BINARY));
    layer.receive(Uint8Array.of(0xf5, 0xc3, T.IAC, T.EOR));

    expect(records).toHaveLength(1);
    expect(Array.from(records[0]!)).toEqual([0xf5, 0xc3]);
  });

  it('discards a record terminated before 3270 mode was negotiated', () => {
    const { layer, records } = harness();
    layer.receive(Uint8Array.of(0x68, 0x69, T.IAC, T.EOR));
    expect(records).toHaveLength(0);
  });

  it('answers a repeated DO ECHO only once, per RFC 854', () => {
    const { layer, sent } = harness();
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.ECHO));
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.ECHO));
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.ECHO));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual([T.IAC, T.WILL, O.ECHO]);
  });

  it('abandons an unterminated subnegotiation instead of eating the stream', () => {
    // St.Sb is left only on IAC SE, so a malformed or truncated subnegotiation
    // would otherwise consume everything after it and present as a hang. This
    // sends exactly enough filler after "IAC SB 99" to hit the 1024-byte cap
    // with nothing left over, so the abandonment lands exactly on a chunk
    // boundary and the next chunk is unambiguously a fresh, well-formed record.
    const { layer, records } = in3270();
    layer.receive(Uint8Array.of(T.IAC, T.SB, 99));
    layer.receive(new Uint8Array(1024).fill(0x41)); // never terminated
    layer.receive(Uint8Array.of(0xf5, 0xc3, T.IAC, T.EOR));
    expect(records).toHaveLength(1);
    expect(Array.from(records[0]!)).toEqual([0xf5, 0xc3]);
  });

  it('un-doubles IAC IAC inside an inbound subnegotiation body', () => {
    // The inbound direction was already correct, and matches x3270: St.SbIac
    // falls through to `this.sb.push(c)` for any non-SE byte, so IAC IAC stores
    // one 0xff — the same shape as x3270's TNS_SB_IAC, which for c != SE leaves
    // the byte it already stored via `*sbptr++ = c` (telnet.c:1994-1996) and
    // returns to TNS_SB. Observed through the trace note, because an option byte
    // of 0xff can only have arrived as a doubled IAC.
    const trace = new Trace({ enabled: true, clock: () => 0 });
    const layer = new TelnetLayer({ write: () => {}, onRecord: () => {}, trace });
    layer.receive(Uint8Array.of(T.IAC, T.SB, T.IAC, T.IAC, 1, 2, T.IAC, T.SE));
    expect(trace.lines()).toContain('0.000 = # ignored subnegotiation for option 255');
  });

  it('caps an unterminated subnegotiation made of escaped IACs', () => {
    // The ceiling was checked only on the St.Sb path, so a body of IAC IAC pairs
    // routed through St.SbIac -> sb.push() bypassed it entirely and grew the
    // number[] without bound — the exact heap exhaustion MAX_SUBNEG_BYTES exists
    // to prevent, just via the escaped-byte door. Measured before the fix: 200000
    // escaped IACs left this.sb at 200001 entries with no note emitted.
    // Sized exactly, like the plain-filler test above, so abandonment lands on
    // the chunk boundary with no pair left over: a leftover pair would be re-read
    // in St.Data as escaped data and prepended to the next record — correct
    // behaviour, but it would mask what this asserts. MAX_SUBNEG_BYTES pairs, not
    // one more, because the option byte 99 already occupies the first slot.
    const { layer, records } = in3270();
    layer.receive(Uint8Array.of(T.IAC, T.SB, 99));
    const pairs = new Uint8Array(MAX_SUBNEG_BYTES * 2);
    pairs.fill(T.IAC); // every byte an IAC, so every pair is one escaped 0xff
    layer.receive(pairs);
    layer.receive(Uint8Array.of(0xf5, 0xc3, T.IAC, T.EOR));
    expect(records).toHaveLength(1);
    expect(Array.from(records[0]!)).toEqual([0xf5, 0xc3]);
  });

  it('caps a record made of escaped IACs', () => {
    // Same hole on the record path: St.Iac's `this.record.push(0xff)` skipped the
    // MAX_RECORD_BYTES check that St.Data applies, so escaped IACs grew the
    // accumulator past the ceiling. Measured before the fix: 100000 escaped IACs
    // left this.record at 100000 entries against a 65536 cap.
    const { layer, records } = in3270();
    const pairs = new Uint8Array(MAX_RECORD_BYTES * 2 + 64);
    pairs.fill(T.IAC);
    layer.receive(pairs);
    layer.receive(Uint8Array.of(T.IAC, T.EOR));
    expect(records).toHaveLength(0);
    layer.receive(Uint8Array.of(0xf5, 0xc3, T.IAC, T.EOR));
    expect(Array.from(records[0]!)).toEqual([0xf5, 0xc3]);
  });

  it('does not leak an escaped IAC into the record outside 3270 mode', () => {
    // St.Data drops NVT text, but St.Iac's escaped-IAC branch pushed 0xff
    // unconditionally, so a doubled IAC in the pre-3270 banner became the first
    // byte of the first real record. Measured before the fix: the record came out
    // as [255, 245, 195] instead of [245, 195]. x3270 gates the escaped-IAC
    // branch on mode too — telnet.c:1744-1745,
    //     case IAC:	/* escaped IAC, insert it */
    //         if (IN_NVT && !IN_E) {
    // sends it to nvt_process() and only the else calls store3270in(c)
    // (telnet.c:1772-1773).
    const { layer, records } = harness();
    layer.receive(Uint8Array.of(T.IAC, T.IAC)); // doubled IAC while still NVT
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.EOR, T.IAC, T.WILL, O.EOR));
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.BINARY, T.IAC, T.WILL, O.BINARY));
    layer.receive(Uint8Array.of(0xf5, 0xc3, T.IAC, T.EOR));
    expect(records).toHaveLength(1);
    expect(Array.from(records[0]!)).toEqual([0xf5, 0xc3]);
  });

  it('drops an over-long record rather than growing without bound', () => {
    const { layer, records } = in3270();
    layer.receive(new Uint8Array(MAX_RECORD_BYTES + 16).fill(0x41));
    layer.receive(Uint8Array.of(T.IAC, T.EOR));
    expect(records).toHaveLength(0);
    // And the layer recovers for the next record.
    layer.receive(Uint8Array.of(0xf5, 0xc3, T.IAC, T.EOR));
    expect(Array.from(records[0]!)).toEqual([0xf5, 0xc3]);
  });
});

describe('transmission', () => {
  it('doubles IAC on output and appends IAC EOR', () => {
    const { layer, sent } = harness();
    layer.sendRecord(Uint8Array.of(0x7d, 0xff, 0x40));
    expect(sent[0]).toEqual([0x7d, T.IAC, T.IAC, 0x40, T.IAC, T.EOR]);
  });

  it('sends Attn as IAC BREAK, per RFC 1576', () => {
    const { layer, sent } = harness();
    layer.sendAttn();
    expect(sent[0]).toEqual([T.IAC, T.BREAK]);
  });
});

describe('trace wiring', () => {
  it('records negotiation, record framing, and Attn through an attached Trace', () => {
    const sent: number[][] = [];
    const records: Uint8Array[] = [];
    const trace = new Trace({ enabled: true, clock: () => 0 });
    const layer = new TelnetLayer({
      write: (b) => sent.push(Array.from(b)),
      onRecord: (r) => records.push(r),
      trace,
    });

    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TERMINAL_TYPE));
    layer.receive(Uint8Array.of(T.IAC, T.SB, O.TERMINAL_TYPE, S.SEND, T.IAC, T.SE));
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.EOR, T.IAC, T.WILL, O.EOR));
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.BINARY, T.IAC, T.WILL, O.BINARY));
    layer.receive(Uint8Array.of(0xf5, 0xc3, T.IAC, T.EOR));
    layer.sendRecord(Uint8Array.of(0x7d));
    layer.sendAttn();

    const lines = trace.lines();
    expect(lines.length).toBeGreaterThan(0);
    // At least one received line (negotiation) and one sent line (our WILL reply).
    expect(lines.some((l) => l.includes(' < '))).toBe(true);
    expect(lines.some((l) => l.includes(' > '))).toBe(true);
  });
});

describe('TN3270E telnet option (40)', () => {
  /** As `harness`, with TN3270E control and a subnegotiation-body collector. */
  function eHarness(tn3270eEnabled: boolean) {
    const sent: number[][] = [];
    const records: Uint8Array[] = [];
    const bodies: Uint8Array[] = [];
    const layer = new TelnetLayer({
      write: (b) => sent.push(Array.from(b)),
      onRecord: (r) => records.push(r),
      terminalType: 'IBM-3278-2-E',
      tn3270eEnabled,
      onTn3270eSubneg: (body) => bodies.push(body),
    });
    return { layer, sent, records, bodies };
  }

  it('answers DO TN3270E with WILL when enabled', () => {
    const { layer, sent } = eHarness(true);
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TN3270E));
    expect(sent).toEqual([[T.IAC, T.WILL, O.TN3270E]]);
  });

  it('answers DO TN3270E with WONT when disabled', () => {
    // What -tn3270e off and the N: prefix must produce, and what keeps this stage a
    // strict addition against the two Hercules hosts.
    const { layer, sent } = eHarness(false);
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TN3270E));
    expect(sent).toEqual([[T.IAC, T.WONT, O.TN3270E]]);
  });

  it('defaults to enabled when the option is not passed at all', () => {
    const { layer, sent } = harness();
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TN3270E));
    expect(sent).toEqual([[T.IAC, T.WILL, O.TN3270E]]);
  });

  it('does not re-answer a repeated DO, per RFC 854', () => {
    // "essential to prevent endless loops in the negotiation" -- the same guard the
    // other accepted options already have.
    const { layer, sent } = eHarness(true);
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TN3270E, T.IAC, T.DO, O.TN3270E));
    expect(sent).toEqual([[T.IAC, T.WILL, O.TN3270E]]);
  });

  it('hands a TN3270E subnegotiation body up with the option byte stripped', () => {
    const { layer, bodies } = eHarness(true);
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TN3270E));
    layer.receive(Uint8Array.of(T.IAC, T.SB, O.TN3270E, 0x08, 0x02, T.IAC, T.SE));
    expect(bodies.map((b) => Array.from(b))).toEqual([[0x08, 0x02]]);
  });

  it('un-doubles IAC IAC inside a TN3270E subnegotiation body', () => {
    // The accumulator already does this for TERMINAL-TYPE; asserting it here keeps
    // the two paths from diverging, which is how a previous escaped-byte defect got in.
    const { layer, bodies } = eHarness(true);
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TN3270E));
    layer.receive(Uint8Array.of(
      T.IAC, T.SB, O.TN3270E, 0x02, 0x04, T.IAC, T.IAC, 0x41, T.IAC, T.SE));
    expect(Array.from(bodies[0]!)).toEqual([0x02, 0x04, 0xff, 0x41]);
  });

  it('frames an outbound subnegotiation and doubles IAC in its body', () => {
    // RFC 855's last paragraph: a 0xff in a subnegotiation PARAMETER must be doubled.
    // The bracketing IAC SB and IAC SE are commands and stay single -- the same rule
    // the TERMINAL-TYPE path follows.
    const { layer, sent } = eHarness(true);
    layer.sendTn3270eSubneg(Uint8Array.of(0x02, 0x07, 0xff, 0x41));
    expect(sent).toEqual([[
      T.IAC, T.SB, O.TN3270E, 0x02, 0x07, T.IAC, T.IAC, 0x41, T.IAC, T.SE,
    ]]);
  });

  it('IS IN 3270 MODE ON TN3270E ALONE, with no BINARY or EOR negotiated', () => {
    // RFC 2355 §4: binary and EOR are IMPLIED by TN3270E, not negotiated -- "a party
    // to the negotiation that agrees to support TN3270E is automatically required to
    // support bi-directional binary and EOR transmissions." Measured: a harness
    // sending only DO TN3270E still gets records out of real s3270.
    //
    // Without this second route, every inbound byte of a TN3270E session is dropped
    // by storeRecordByte and every record discarded by flushRecord: a perfect
    // negotiation that renders nothing.
    const { layer } = eHarness(true);
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TN3270E));
    expect(layer.is3270Mode()).toBe(false);   // agreed, but not yet negotiated
    layer.setTn3270eNegotiated(true);
    expect(layer.is3270Mode()).toBe(true);
  });

  it('delivers a record in TN3270E mode without BINARY or EOR', () => {
    // The end-to-end consequence of the gate above.
    const { layer, records } = eHarness(true);
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TN3270E));
    layer.setTn3270eNegotiated(true);
    layer.receive(Uint8Array.of(0x00, 0x00, 0x00, 0x00, 0x00, 0xf5, T.IAC, T.EOR));
    expect(records.map((r) => Array.from(r))).toEqual([[0, 0, 0, 0, 0, 0xf5]]);
  });

  it('still reaches 3270 mode the classic way when TN3270E is absent', () => {
    // Regression guard: the Hercules path must be untouched by the widened gate.
    const { layer } = eHarness(true);
    layer.receive(Uint8Array.of(
      T.IAC, T.DO, O.BINARY, T.IAC, T.WILL, O.BINARY,
      T.IAC, T.DO, O.EOR, T.IAC, T.WILL, O.EOR,
    ));
    expect(layer.is3270Mode()).toBe(true);
  });

  it('refuseTn3270e sends WONT and drops back out of 3270 mode', () => {
    const { layer, sent } = eHarness(true);
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TN3270E));
    layer.setTn3270eNegotiated(true);
    expect(layer.is3270Mode()).toBe(true);
    sent.length = 0;
    layer.refuseTn3270e();
    expect(sent).toEqual([[T.IAC, T.WONT, O.TN3270E]]);
    expect(layer.is3270Mode()).toBe(false);
  });

  it('can still accept TN3270E again after a refusal', () => {
    // backoff_tn3270e clears myopts so the option could be renegotiated; ours must
    // not latch off, or a reconnect on the same layer would silently decline.
    const { layer, sent } = eHarness(true);
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TN3270E));
    layer.refuseTn3270e();
    sent.length = 0;
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TN3270E));
    expect(sent).toEqual([[T.IAC, T.WILL, O.TN3270E]]);
  });

  it('ignores a TN3270E subnegotiation when no consumer was wired', () => {
    // The replay path builds a layer without the callback; a subnegotiation arriving
    // there must be dropped rather than throwing on an undefined function.
    const { layer } = harness();
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TN3270E));
    expect(() => layer.receive(
      Uint8Array.of(T.IAC, T.SB, O.TN3270E, 0x08, 0x02, T.IAC, T.SE))).not.toThrow();
  });
});
