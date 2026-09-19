import { describe, it, expect } from 'vitest';
import { DeviceName } from '../src/devname.js';

/**
 * x3270's devname_init (Common/devname.c:42) and devname_next (:73). The observable
 * behaviour comes from two real traces, not from reasoning:
 *   devname_success.trc: foo001, foo002, foo003, foo004   (template foo===)
 *   devname_failure.trc: foo1, foo2, foo3                 (template foo=)
 */
describe('DeviceName', () => {
  it('replaces trailing = with a zero-padded counter, starting at 1', () => {
    // NOT 000. `devname_next` pre-increments and is called on the FIRST request, so the
    // first name a host ever sees ends in 001. Pinned because starting at 0 is the
    // natural way to write this and would silently differ from every recorded trace.
    const d = new DeviceName('foo===');
    expect(d.next()).toBe('foo001');
    expect(d.next()).toBe('foo002');
    expect(d.next()).toBe('foo003');
  });

  it('matches devname_failure.trc s single-digit template', () => {
    const d = new DeviceName('foo=');
    expect(d.next()).toBe('foo1');
    expect(d.next()).toBe('foo2');
    expect(d.next()).toBe('foo3');
  });

  it('REPEATS the last name at the ceiling rather than wrapping', () => {
    // x3270 guards with `if (d->current < d->max)` and otherwise returns the template
    // unchanged, so the counter saturates. Wrapping to 1 would silently re-offer a name
    // the host already refused, which is the one thing this mechanism exists to avoid.
    const d = new DeviceName('x=');
    const seen = [];
    for (let i = 0; i < 11; i++) seen.push(d.next());
    expect(seen.slice(0, 9)).toEqual(
      ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9']);
    expect(seen[9]).toBe('x9');
    expect(seen[10]).toBe('x9');
  });

  it('treats a template with no = as a fixed name', () => {
    // `-devname MYLU` is the common case and must not grow a counter.
    const d = new DeviceName('MYLU');
    expect(d.next()).toBe('MYLU');
    expect(d.next()).toBe('MYLU');
  });

  it('counts only TRAILING = characters', () => {
    // An `=` in the middle is part of the name. x3270 scans backwards from the end and
    // stops at the first non-`=`.
    const d = new DeviceName('a=b==');
    expect(d.next()).toBe('a=b01');
  });

  it('caps an absurdly long run of trailing = rather than overflowing Number', () => {
    // 10 ** digits exceeds Number.MAX_SAFE_INTEGER past 15 '=' characters. A template
    // asking for 20 digits is almost certainly a typo, not a real device-name scheme,
    // so digits beyond the cap are treated as part of the stem instead of silently
    // producing a `max` that Number can no longer represent exactly.
    const d = new DeviceName('x' + '='.repeat(20));
    expect(d.next()).toBe('x' + '='.repeat(5) + '0'.repeat(14) + '1');
  });
});
