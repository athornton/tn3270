import { describe, it, expect } from 'vitest';
import { parseRecord, ParseError, describeRecord } from '../src/stream/parse.js';
import { SnaCmd, Cmd, Order, FA } from '../src/constants.js';

describe('command recognition', () => {
  it('parses an Erase/Write with a WCC', () => {
    const r = parseRecord(Uint8Array.of(SnaCmd.EW, 0xc3));
    expect(r.command).toBe('EraseWrite');
    expect(r.wcc).toBe(0xc3);
    expect(r.tokens).toEqual([]);
  });

  it('accepts the non-SNA encoding of the same command', () => {
    expect(parseRecord(Uint8Array.of(Cmd.EW, 0xc3)).command).toBe('EraseWrite');
    expect(parseRecord(Uint8Array.of(Cmd.W, 0x00)).command).toBe('Write');
    expect(parseRecord(Uint8Array.of(Cmd.EWA, 0x00)).command).toBe('EraseWriteAlternate');
    expect(parseRecord(Uint8Array.of(Cmd.RB)).command).toBe('ReadBuffer');
    expect(parseRecord(Uint8Array.of(Cmd.RM)).command).toBe('ReadModified');
    expect(parseRecord(Uint8Array.of(Cmd.RMA)).command).toBe('ReadModifiedAll');
    expect(parseRecord(Uint8Array.of(Cmd.EAU)).command).toBe('EraseAllUnprotected');
  });

  it('parses the read commands, which carry no WCC', () => {
    expect(parseRecord(Uint8Array.of(SnaCmd.RB)).command).toBe('ReadBuffer');
    expect(parseRecord(Uint8Array.of(SnaCmd.RM)).command).toBe('ReadModified');
    expect(parseRecord(Uint8Array.of(SnaCmd.RMA)).command).toBe('ReadModifiedAll');
    expect(parseRecord(Uint8Array.of(SnaCmd.RB)).wcc).toBeUndefined();
  });

  it('parses Erase All Unprotected, which carries no WCC', () => {
    const r = parseRecord(Uint8Array.of(SnaCmd.EAU));
    expect(r.command).toBe('EraseAllUnprotected');
    expect(r.wcc).toBeUndefined();
  });

  it('parses Write Structured Field into typed structured fields', () => {
    const r = parseRecord(Uint8Array.of(SnaCmd.WSF, 0x00, 0x05, 0x01, 0xff, 0x02));
    expect(r.command).toBe('WriteStructuredField');
    expect(r.tokens).toEqual([
      { kind: 'structuredField', field: { kind: 'readPartition', pid: 0xff, type: 0x02 } },
    ]);
  });

  it('emits one token per structured field, not one per record', () => {
    // A WSF legitimately carries several fields; the per-field tokenisation is
    // what task 7 iterates. One Read Partition Query, then an unknown SFID.
    const r = parseRecord(Uint8Array.of(
      SnaCmd.WSF, 0x00, 0x05, 0x01, 0xff, 0x02, 0x00, 0x04, 0x40, 0xaa,
    ));
    expect(r.tokens).toEqual([
      { kind: 'structuredField', field: { kind: 'readPartition', pid: 0xff, type: 0x02 } },
      { kind: 'structuredField', field: { kind: 'unknownSf', sfid: 0x40, data: Uint8Array.of(0xaa) } },
    ]);
  });

  it('rejects a WSF whose declared length exceeds the payload', () => {
    // Was accepted while the payload was opaque. A length of 5 with 2 bytes
    // present is malformed and must not reach the executor.
    expect(() => parseRecord(Uint8Array.of(SnaCmd.WSF, 0x00, 0x05))).toThrow(ParseError);
  });

  it('accepts BOTH WSF encodings, including non-SNA 0x11', () => {
    // Cmd.WSF is 0x11, numerically identical to Order.SBA. Position
    // disambiguates: commandOf only ever sees the command byte. x3270 accepts
    // both (`case CMD_WSF: case SNA_CMD_WSF:` at ctlr.c:749-750).
    expect(parseRecord(Uint8Array.of(SnaCmd.WSF, 0x00, 0x05, 0x01, 0xff, 0x02)).command)
      .toBe('WriteStructuredField');
    expect(parseRecord(Uint8Array.of(Cmd.WSF, 0x00, 0x05, 0x01, 0xff, 0x02)).command)
      .toBe('WriteStructuredField');
    // And 0x11 in ORDER position is still SBA, not a nested WSF.
    const r = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SBA, 0x40, 0x40));
    expect(r.tokens[0]).toEqual({ kind: 'sba', address: 0 });
  });

  it('rejects an empty record', () => {
    expect(() => parseRecord(new Uint8Array(0))).toThrow(ParseError);
  });

  it('rejects an unknown command byte', () => {
    expect(() => parseRecord(Uint8Array.of(0x99, 0x00))).toThrow(ParseError);
  });

  it('rejects a write command with no WCC byte', () => {
    expect(() => parseRecord(Uint8Array.of(SnaCmd.EW))).toThrow(ParseError);
  });
});

describe('order parsing', () => {
  it('parses SBA with a 12-bit address', () => {
    const r = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SBA, 0xc2, 0x60));
    expect(r.tokens).toEqual([{ kind: 'sba', address: 160 }]);
  });

  it('parses SF with its attribute', () => {
    const r = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SF, FA.PROTECT));
    expect(r.tokens).toEqual([{ kind: 'sf', attr: FA.PROTECT }]);
  });

  it('parses IC and PT, which take no operands', () => {
    const r = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.IC, Order.PT));
    expect(r.tokens).toEqual([{ kind: 'ic' }, { kind: 'pt' }]);
  });

  it('parses RA with its address and fill character', () => {
    const r = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.RA, 0xc2, 0x60, 0x5c));
    expect(r.tokens).toEqual([{ kind: 'ra', stop: 160, fill: 0x5c, ge: false }]);
  });

  it('parses RA with a GE before the fill character', () => {
    const r = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.RA, 0x40, 0xc5, Order.GE, 0xf1));
    expect(r.tokens).toEqual([{ kind: 'ra', stop: 5, fill: 0xf1, ge: true }]);
  });

  it('rejects RA whose GE has no following fill character', () => {
    expect(() => parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.RA, 0x40, 0xc5, Order.GE)))
      .toThrow(ParseError);
  });

  it('parses EUA with its stop address', () => {
    const r = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.EUA, 0xc2, 0x60));
    expect(r.tokens).toEqual([{ kind: 'eua', stop: 160 }]);
  });

  it('parses GE and the character it escapes', () => {
    const r = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.GE, 0xf1));
    expect(r.tokens).toEqual([{ kind: 'ge', ebcdic: 0xf1 }]);
  });

  it('collects data bytes into runs', () => {
    const r = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, 0xc8, 0xc5, 0xd3));
    expect(r.tokens).toHaveLength(1);
    expect(r.tokens[0]).toEqual({ kind: 'data', bytes: Uint8Array.of(0xc8, 0xc5, 0xd3) });
  });

  it('breaks a data run at an order and resumes after it', () => {
    const r = parseRecord(Uint8Array.of(
      SnaCmd.W, 0x00, 0xc8, 0xc5, Order.SBA, 0xc2, 0x60, 0xd3, 0xd6,
    ));
    expect(r.tokens).toEqual([
      { kind: 'data', bytes: Uint8Array.of(0xc8, 0xc5) },
      { kind: 'sba', address: 160 },
      { kind: 'data', bytes: Uint8Array.of(0xd3, 0xd6) },
    ]);
  });

  it('recognizes deferred orders and records their operand length', () => {
    // SA and MF are not executed in stage 2a, but must be skipped by the
    // right number of bytes or everything after them is garbage.
    const sa = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SA, 0x42, 0xf2, 0xc1));
    expect(sa.tokens).toEqual([
      { kind: 'deferred', order: Order.SA, data: Uint8Array.of(0x42, 0xf2) },
      { kind: 'data', bytes: Uint8Array.of(0xc1) },
    ]);

    // MF: one count byte, then that many type/value pairs.
    const mf = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.MF, 0x02, 0xc0, 0xf8, 0x42, 0xf2, 0xc1));
    expect(mf.tokens[0]).toEqual({
      kind: 'deferred', order: Order.MF,
      data: Uint8Array.of(0x02, 0xc0, 0xf8, 0x42, 0xf2),
    });
    expect(mf.tokens[1]).toEqual({ kind: 'data', bytes: Uint8Array.of(0xc1) });
  });

  it('decodes SFE attribute pairs', () => {
    // SFE, 1 pair, type 0xC0 (3270 field attribute) value 0x60 (protected).
    const r = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SFE, 0x01, 0xc0, 0x60));
    expect(r.tokens).toEqual([
      { kind: 'sfe', pairs: [{ type: 0xc0, value: 0x60 }] },
    ]);
  });

  it('decodes an SFE with several pairs, keeping ones we do not honour', () => {
    // Type 0x42 is colour, which stage 2a drops at EXECUTE time — but the
    // parser still reports it, so the trace shows what the host actually sent.
    const r = parseRecord(Uint8Array.of(
      SnaCmd.W, 0x00, Order.SFE, 0x02, 0xc0, 0x60, 0x42, 0xf4));
    expect(r.tokens[0]).toEqual({
      kind: 'sfe',
      pairs: [{ type: 0xc0, value: 0x60 }, { type: 0x42, value: 0xf4 }],
    });
  });

  it('accepts an SFE with zero pairs', () => {
    // p. 4-5: "If SFE is sent with no type-value pairs (zero value for number
    // of pairs), defaults are set." It still defines a field.
    const r = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SFE, 0x00));
    expect(r.tokens).toEqual([{ kind: 'sfe', pairs: [] }]);
  });

  it('resumes reading data after an SFE, not inside its pairs', () => {
    const r = parseRecord(Uint8Array.of(
      SnaCmd.W, 0x00, Order.SFE, 0x01, 0xc0, 0x60, 0xc1, 0xc2));
    expect(r.tokens).toEqual([
      { kind: 'sfe', pairs: [{ type: 0xc0, value: 0x60 }] },
      { kind: 'data', bytes: Uint8Array.of(0xc1, 0xc2) },
    ]);
  });

  it('rejects an SFE whose pair count runs past the record', () => {
    expect(() => parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SFE, 0x04, 0xc0, 0x60)))
      .toThrow(ParseError);
  });

  it('rejects an SFE with no count byte at all', () => {
    expect(() => parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SFE)))
      .toThrow(ParseError);
  });

  it('leaves SA and MF as deferred tokens', () => {
    const sa = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SA, 0x42, 0xf4));
    expect(sa.tokens).toEqual([
      { kind: 'deferred', order: Order.SA, data: Uint8Array.of(0x42, 0xf4) },
    ]);
    const mf = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.MF, 0x01, 0xc0, 0x60));
    expect(mf.tokens).toEqual([
      { kind: 'deferred', order: Order.MF, data: Uint8Array.of(0x01, 0xc0, 0x60) },
    ]);
  });

  it('rejects an order truncated by the end of the record', () => {
    expect(() => parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SBA, 0xc2)))
      .toThrow(ParseError);
    expect(() => parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SF)))
      .toThrow(ParseError);
    expect(() => parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.RA, 0xc2, 0x60)))
      .toThrow(ParseError);
  });

  it('rejects a reserved address flag combination', () => {
    // Flags 10 must reject the datastream (GA23-0059-07).
    expect(() => parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SBA, 0x80, 0x40)))
      .toThrow(ParseError);
  });

  it('carries 0xFF through as ordinary data', () => {
    // The telnet layer already unescaped IAC IAC; 0xff is just a byte here.
    const r = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, 0xff));
    expect(r.tokens[0]).toEqual({ kind: 'data', bytes: Uint8Array.of(0xff) });
  });
});

describe('describeRecord', () => {
  it('renders a human-readable annotation for the trace', () => {
    const text = describeRecord(Uint8Array.of(
      SnaCmd.EW, 0xc3, Order.SBA, 0xc2, 0x60, Order.SF, FA.PROTECT, 0xc1,
    ));
    expect(text).toContain('EraseWrite');
    expect(text).toContain('SBA(160)');
    expect(text).toContain('SF');
    expect(text).toContain('data[1]');
  });

  it('renders both structured field kinds, with PID padded', () => {
    // Exact equality, not toContain: `toContain('SF')` passes on the substring
    // inside "WriteStructuredField" and so pins nothing. PID 0x00 here is the
    // padding case — a read of partition 0, which must not render as "pid=0x0".
    expect(describeRecord(Uint8Array.of(
      SnaCmd.WSF, 0x00, 0x05, 0x01, 0x00, 0x02, 0x00, 0x04, 0x40, 0xaa,
    ))).toBe('WriteStructuredField ReadPartition(pid=0x00,type=0x02) unknownSF(0x40,1B)');
  });

  it('does not render an unknown structured field the way it renders a SF order', () => {
    // Both used to start "SF(", so one grep over a trace returned both.
    const order = describeRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SF, FA.PROTECT));
    const sf = describeRecord(Uint8Array.of(SnaCmd.WSF, 0x00, 0x04, 0x40, 0xaa));
    expect(order).toBe('Write WCC=0x00 SF(0x20)');
    expect(sf).toBe('WriteStructuredField unknownSF(0x40,1B)');
  });

  it('renders SFE pairs with both hex halves padded', () => {
    // Value 0x00 is the padding case: an SFE pair type 0xC0 value 0x00 is an
    // unprotected alphanumeric field, a real byte off the wire, and "0x0" would
    // read as a truncation bug rather than the attribute the host sent.
    expect(describeRecord(Uint8Array.of(
      SnaCmd.W, 0x00, Order.SFE, 0x02, 0xc0, 0x00, 0x42, 0xf4,
    ))).toBe('Write WCC=0x00 SFE(0xc0=0x00,0x42=0xf4)');
    expect(describeRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SFE, 0x00)))
      .toBe('Write WCC=0x00 SFE()');
  });

  it('describes an unparseable record without throwing', () => {
    expect(describeRecord(Uint8Array.of(0x99))).toContain('unparseable');
  });
});
