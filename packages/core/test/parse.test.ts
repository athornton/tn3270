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

  it('parses Write Structured Field and keeps the payload unexamined', () => {
    const r = parseRecord(Uint8Array.of(SnaCmd.WSF, 0x00, 0x05, 0x01, 0xff, 0x02));
    expect(r.command).toBe('WriteStructuredField');
    expect(r.tokens).toHaveLength(1);
    expect(r.tokens[0]).toEqual({
      kind: 'structuredFields',
      data: Uint8Array.of(0x00, 0x05, 0x01, 0xff, 0x02),
    });
  });

  it('accepts BOTH WSF encodings, including non-SNA 0x11', () => {
    // Cmd.WSF is 0x11, numerically identical to Order.SBA. Position
    // disambiguates: commandOf only ever sees the command byte. x3270 accepts
    // both (`case CMD_WSF: case SNA_CMD_WSF:` at ctlr.c:749-750).
    expect(parseRecord(Uint8Array.of(SnaCmd.WSF, 0x00, 0x05)).command)
      .toBe('WriteStructuredField');
    expect(parseRecord(Uint8Array.of(Cmd.WSF, 0x00, 0x05)).command)
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
    expect(r.tokens).toEqual([{ kind: 'ra', stop: 160, fill: 0x5c }]);
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
    // SA, SFE and MF are not executed in stage 1, but must be skipped by the
    // right number of bytes or everything after them is garbage.
    const sa = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SA, 0x42, 0xf2, 0xc1));
    expect(sa.tokens).toEqual([
      { kind: 'deferred', order: Order.SA, data: Uint8Array.of(0x42, 0xf2) },
      { kind: 'data', bytes: Uint8Array.of(0xc1) },
    ]);

    // SFE: one count byte, then that many type/value pairs.
    const sfe = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SFE, 0x02, 0xc0, 0xf8, 0x42, 0xf2, 0xc1));
    expect(sfe.tokens[0]).toEqual({
      kind: 'deferred', order: Order.SFE,
      data: Uint8Array.of(0x02, 0xc0, 0xf8, 0x42, 0xf2),
    });
    expect(sfe.tokens[1]).toEqual({ kind: 'data', bytes: Uint8Array.of(0xc1) });

    const mf = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.MF, 0x01, 0xc0, 0xf8, 0xc1));
    expect(mf.tokens[0]).toEqual({
      kind: 'deferred', order: Order.MF, data: Uint8Array.of(0x01, 0xc0, 0xf8),
    });
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

  it('describes an unparseable record without throwing', () => {
    expect(describeRecord(Uint8Array.of(0x99))).toContain('unparseable');
  });
});
