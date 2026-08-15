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

  it('wraps long byte runs at 16 per line', () => {
    const t = new Trace({ enabled: true, clock: () => 0 });
    t.recv(new Uint8Array(20).fill(0xab));
    const lines = t.lines();
    expect(lines).toHaveLength(2);
    expect(lines[0]!.split(' ').length).toBe(2 + 16);
    expect(lines[1]!.split(' ').length).toBe(2 + 4);
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

  it('merges continuation lines of a wrapped run', () => {
    const text = ['0.000 < ' + 'ab '.repeat(16).trim(), '0.000 < ab ab'].join('\n');
    const events = parseTrace(text);
    expect(events).toHaveLength(2);
    expect(events[0]!.bytes).toHaveLength(16);
    expect(events[1]!.bytes).toHaveLength(2);
  });

  it('ignores blank lines and comments', () => {
    expect(parseTrace('\n# a comment\n\n')).toEqual([]);
  });
});
