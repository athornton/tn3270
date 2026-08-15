import { describe, it, expect } from 'vitest';
import { Trace, parseTrace } from '../src/trace.js';

describe('Trace', () => {
  it('records nothing when disabled', () => {
    const t = new Trace();
    t.recv(Uint8Array.of(1, 2, 3));
    expect(t.lines()).toEqual([]);
  });

  it('records inbound and outbound bytes with direction markers', () => {
    const t = new Trace({ enabled: true, clock: () => 0 });
    t.recv(Uint8Array.of(0xf5, 0xc3));
    t.send(Uint8Array.of(0x7d));
    const lines = t.lines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('0.000 < f5 c3');
    expect(lines[1]).toBe('0.000 > 7d');
  });

  it('advances timestamps from the injected clock', () => {
    let now = 1000;
    const t = new Trace({ enabled: true, clock: () => now });
    t.recv(Uint8Array.of(1));
    now = 1250;
    t.recv(Uint8Array.of(2));
    expect(t.lines()[0]).toBe('0.000 < 01');
    expect(t.lines()[1]).toBe('0.250 < 02');
  });

  it('clamps elapsed time at 0 if the clock steps backward', () => {
    let now = 1000;
    const t = new Trace({ enabled: true, clock: () => now });
    t.recv(Uint8Array.of(1));
    now = 500; // e.g. an NTP correction on a non-monotonic clock
    t.recv(Uint8Array.of(2));
    expect(t.lines()[0]).toBe('0.000 < 01');
    expect(t.lines()[1]).toBe('0.000 < 02');
  });

  it('appends annotations without disturbing the hex', () => {
    const t = new Trace({ enabled: true, clock: () => 0 });
    t.recv(Uint8Array.of(0xf5), 'Erase/Write');
    expect(t.lines()[0]).toBe('0.000 < f5  # Erase/Write');
  });

  it('records notes with no bytes at all', () => {
    const t = new Trace({ enabled: true, clock: () => 0 });
    t.note('negotiated 3270 mode');
    expect(t.lines()[0]).toBe('0.000 = # negotiated 3270 mode');
  });

  it('sanitizes newlines in notes and annotations so they cannot forge a line', () => {
    const t = new Trace({ enabled: true, clock: () => 0 });
    t.note('host said:\n0.000 < de ad be ef');
    expect(t.lines()).toHaveLength(1);
    expect(t.lines()[0]).toBe('0.000 = # host said: 0.000 < de ad be ef');
    expect(parseTrace(t.lines()[0]!)).toEqual([]);
  });

  it('wraps long byte runs at 16 per line', () => {
    const t = new Trace({ enabled: true, clock: () => 0 });
    t.recv(new Uint8Array(20).fill(0xab));
    const lines = t.lines();
    expect(lines).toHaveLength(2);
    expect(lines[0]!.split(' ').length).toBe(2 + 16);
    expect(lines[1]!.split(' ').length).toBe(2 + 4);
  });

  it('marks continuation lines of a wrapped run with a leading +', () => {
    const t = new Trace({ enabled: true, clock: () => 0 });
    t.recv(new Uint8Array(20).fill(0xab));
    const lines = t.lines();
    expect(lines[0]!.startsWith('0.000 < ')).toBe(true);
    expect(lines[1]!.startsWith('0.000 + ')).toBe(true);
  });

  it('does not retain lines when a sink is attached', () => {
    const sunk: string[] = [];
    const t = new Trace({ enabled: true, clock: () => 0, sink: (l) => sunk.push(l) });
    t.recv(Uint8Array.of(0xf5, 0xc3));
    expect(sunk).toEqual(['0.000 < f5 c3']);
    expect(t.lines()).toEqual([]);
  });

  it('returns a snapshot from lines() that mutation cannot affect', () => {
    const t = new Trace({ enabled: true, clock: () => 0 });
    t.recv(Uint8Array.of(0xf5));
    const snapshot = t.lines() as string[];
    snapshot.push('injected');
    expect(t.lines()).toHaveLength(1);
  });
});

describe('parseTrace', () => {
  it('round-trips a trace back into direction-tagged byte runs', () => {
    const t = new Trace({ enabled: true, clock: () => 0 });
    t.recv(Uint8Array.of(0xf5, 0xc3));
    t.send(Uint8Array.of(0x7d));
    t.note('ignored on replay');
    const events = parseTrace(t.lines().join('\n'));
    expect(events).toEqual([
      { dir: 'recv', bytes: Uint8Array.of(0xf5, 0xc3) },
      { dir: 'send', bytes: Uint8Array.of(0x7d) },
    ]);
  });

  it('merges a wrapped run back into the single event it originally was', () => {
    const t = new Trace({ enabled: true, clock: () => 0 });
    const payload = new Uint8Array(20).fill(0xab);
    t.recv(payload);
    const events = parseTrace(t.lines().join('\n'));
    expect(events).toHaveLength(1);
    expect(events[0]!.bytes).toEqual(payload);
  });

  it('keeps two genuinely separate events separate even when each is 16 bytes', () => {
    const t = new Trace({ enabled: true, clock: () => 0 });
    t.recv(new Uint8Array(16).fill(0xab));
    t.recv(new Uint8Array(2).fill(0xab));
    const events = parseTrace(t.lines().join('\n'));
    expect(events).toHaveLength(2);
    expect(events[0]!.bytes).toHaveLength(16);
    expect(events[1]!.bytes).toHaveLength(2);
  });

  it('ignores blank lines and comments', () => {
    expect(parseTrace('\n# a comment\n\n')).toEqual([]);
  });

  it('throws on a malformed hex byte instead of silently coercing it to zero', () => {
    expect(() => parseTrace('0.000 < f5 oops c3')).toThrow(/invalid hex byte "oops"/);
  });

  it('throws on a continuation line with no preceding event', () => {
    expect(() => parseTrace('0.000 + ab ab')).toThrow(/no preceding event/);
  });
});
