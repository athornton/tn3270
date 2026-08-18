import { describe, it, expect } from 'vitest';
import { parseX3270Trace, x3270TraceToOurs } from '../src/x3270trace.js';
import { parseTrace } from '../src/trace.js';

/**
 * x3270's native trace format, per trace_netdata() in Common/telnet.c:3325.
 * Direction char, a byte OFFSET in hex, then unspaced hex bytes, 32 per line.
 */

describe('parseX3270Trace', () => {
  it('reads a single-line record', () => {
    const events = parseX3270Trace('> 0x0   f5c31140401df0\n');
    expect(events).toHaveLength(1);
    expect(Array.from(events[0]!.bytes)).toEqual([0xf5, 0xc3, 0x11, 0x40, 0x40, 0x1d, 0xf0]);
  });

  it('keeps x3270 direction as-is: "<" received, ">" sent', () => {
    // Pinned against bytes only ONE side can plausibly send, so this test cannot
    // pass with the direction inverted — which an earlier version did, because it
    // asserted the mapping abstractly instead of anchoring it to real traffic.
    //
    // IAC DO TERMINAL-TYPE is a host-to-terminal negotiation: a terminal never
    // sends DO TERMINAL-TYPE. IAC SB TERMINAL-TYPE IS "IBM-3278-2" is the
    // terminal's reply and can only come from us.
    // x3270: net_input traces '<' after reading the socket (telnet.c:1519);
    // net_rawout traces '>' on the way out (telnet.c:2917).
    const hostSide = parseX3270Trace('< 0x0   fffd18\n')[0]!;
    expect(hostSide.dir).toBe('recv');
    expect(Array.from(hostSide.bytes)).toEqual([0xff, 0xfd, 0x18]);

    const ourSide = parseX3270Trace('> 0x0   fffa180049424d2d333237382d32fff0\n')[0]!;
    expect(ourSide.dir).toBe('send');
    // ...IS IBM-3278-2...
    expect(Array.from(ourSide.bytes).slice(0, 4)).toEqual([0xff, 0xfa, 0x18, 0x00]);
  });

  it('joins continuation lines by offset into one record', () => {
    // 32 bytes at offset 0, then 2 more at offset 0x20.
    const first = 'ab'.repeat(32);
    const text = `> 0x0   ${first}\n> 0x20  c1c2\n`;
    const events = parseX3270Trace(text);
    expect(events).toHaveLength(1);
    expect(events[0]!.bytes).toHaveLength(34);
    expect(Array.from(events[0]!.bytes.subarray(32))).toEqual([0xc1, 0xc2]);
  });

  it('starts a new record when the offset returns to zero', () => {
    const text = '> 0x0   f5c3\n> 0x0   f1c1\n';
    const events = parseX3270Trace(text);
    expect(events).toHaveLength(2);
    expect(Array.from(events[1]!.bytes)).toEqual([0xf1, 0xc1]);
  });

  it('starts a new record when the direction changes at a nonzero offset', () => {
    // '<' received first, then '>' sent — a host write followed by our reply.
    const text = '< 0x0   f5c3\n> 0x20  7d40\n';
    const events = parseX3270Trace(text);
    expect(events).toHaveLength(2);
    expect(events[0]!.dir).toBe('recv');
    expect(events[1]!.dir).toBe('send');
  });

  it('skips the human-readable annotations x3270 interleaves', () => {
    const text = [
      'RCVD EOR',
      '> 0x0   f5c3',
      '< WriteStructuredField',
      'SENT DO EOR',
      '< 0x0   7d40',
      '',
    ].join('\n');
    const events = parseX3270Trace(text);
    expect(events).toHaveLength(2);
    expect(Array.from(events[0]!.bytes)).toEqual([0xf5, 0xc3]);
    expect(Array.from(events[1]!.bytes)).toEqual([0x7d, 0x40]);
  });

  it('treats an annotation between two dump lines as a record boundary', () => {
    const text = '> 0x0   f5c3\nRCVD EOR\n> 0x20  c1c2\n';
    // The annotation ends the first record; the second line's nonzero offset
    // cannot continue it, so it becomes its own event rather than being lost.
    expect(parseX3270Trace(text)).toHaveLength(2);
  });

  it('rejects an odd number of hex digits rather than dropping a nibble', () => {
    expect(() => parseX3270Trace('> 0x0   f5c\n')).toThrow(/odd hex/i);
  });

  it('returns nothing for a trace with no netdata lines', () => {
    expect(parseX3270Trace('RCVD EOR\nSENT WILL BINARY\n')).toEqual([]);
  });

  it('recognizes the variable-width offset field x3270 pads with %-3x', () => {
    // %-3x left-pads to 3 columns, so "0x0   " has trailing spaces while a
    // record past 256 bytes yields "0x120 ". Both must be recognized as netdata
    // lines rather than mistaken for annotations and skipped. A nonzero offset
    // in the same direction continues the record, so this is one event.
    const events = parseX3270Trace('> 0x0   f5\n> 0x120 c1\n');
    expect(events).toHaveLength(1);
    expect(Array.from(events[0]!.bytes)).toEqual([0xf5, 0xc1]);
  });
});

describe('an event is a socket read, not a record', () => {
  it('keeps two IAC EOR-terminated records in one read as one event', () => {
    // x3270 traces per read() (telnet.c:1519), so one event can hold several
    // records. Confirmed in a real capture: a 966-byte read held two IAC EORs.
    // Consumers that need records must reframe through TelnetLayer.
    const text = '< 0x0   f5c3ffeff1c1ffef\n';
    const events = parseX3270Trace(text);
    expect(events).toHaveLength(1);
    expect(Array.from(events[0]!.bytes)).toEqual([0xf5, 0xc3, 0xff, 0xef, 0xf1, 0xc1, 0xff, 0xef]);
  });
});

describe('x3270TraceToOurs', () => {
  it('produces text our own parseTrace reads back identically', () => {
    const x3270Text = [
      '> 0x0   fffd19fffb19',
      '> 0x0   f5c31140401dc8c9',
      '< 0x0   7d4040',
    ].join('\n');
    const ours = x3270TraceToOurs(x3270Text);
    const roundTripped = parseTrace(ours);
    const direct = parseX3270Trace(x3270Text);
    expect(roundTripped).toHaveLength(direct.length);
    for (let i = 0; i < direct.length; i++) {
      expect(roundTripped[i]!.dir).toBe(direct[i]!.dir);
      expect(Array.from(roundTripped[i]!.bytes)).toEqual(Array.from(direct[i]!.bytes));
    }
  });

  it('wraps a long record with continuation markers our parser rejoins', () => {
    const long = 'ab'.repeat(40); // 40 bytes, more than our 16-per-line
    const ours = x3270TraceToOurs(`> 0x0   ${long}\n`);
    const events = parseTrace(ours);
    expect(events).toHaveLength(1);
    expect(events[0]!.bytes).toHaveLength(40);
  });

  it('records that timestamps are absent rather than inventing them', () => {
    const ours = x3270TraceToOurs('> 0x0   f5c3\n');
    expect(ours).toContain('0.000');
    expect(ours).toMatch(/byte offsets/i);
  });
});
