import { describe, it, expect } from 'vitest';
import { TelnetLayer, MAX_RECORD_BYTES } from '../src/telnet.js';
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

  it('refuses TN3270E in stage 1', () => {
    const { layer, sent } = harness();
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.TN3270E));
    expect(sent[0]).toEqual([T.IAC, T.WONT, O.TN3270E]);
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
