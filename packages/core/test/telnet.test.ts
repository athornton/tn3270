import { describe, it, expect } from 'vitest';
import { TelnetLayer } from '../src/telnet.js';
import { TelnetCmd as T, TelnetOpt as O, TelnetSubopt as S } from '../src/constants.js';

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
