import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionRegistry } from '../src/sessions.js';

/**
 * WHY A GRACE WINDOW EXISTS AT ALL, in one sentence a future editor must not delete: on VM/370 a
 * logged-on session left running means the next LOGON RECONNECTS past the IPL and lands at CP
 * READ, so without reattachment every wifi handoff would arm a trap that has already produced
 * three false failures in this project.
 */
describe('SessionRegistry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** A stand-in for the 3270 session: we assert on lifecycle, not on protocol. */
  const makeFactory = () => {
    const created: Array<{ id: string; closed: boolean; closes: number }> = [];
    const factory = (id: string) => {
      const s = { id, closed: false, closes: 0 };
      created.push(s);
      return { session: s as never, close: () => { s.closed = true; s.closes += 1; } };
    };
    return { factory, created };
  };

  it('creates a session for a hello with no id, and returns the new id', () => {
    const { factory, created } = makeFactory();
    const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 16 });
    const a = reg.attach(undefined);
    expect(a.created).toBe(true);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created).toHaveLength(1);
  });

  it('creates a NEW session for an unknown id rather than erroring', () => {
    // A stale sessionStorage id after a server restart is normal, not exceptional.
    const { factory } = makeFactory();
    const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 16 });
    const a = reg.attach('11111111-1111-1111-1111-111111111111');
    expect(a.created).toBe(true);
    expect(a.id).not.toBe('11111111-1111-1111-1111-111111111111');
  });

  it('reattaches a detached session within the grace window', () => {
    const { factory, created } = makeFactory();
    const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 16 });
    const a = reg.attach(undefined);
    reg.detach(a.id);
    vi.advanceTimersByTime(59_000);
    const b = reg.attach(a.id);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
    expect(created).toHaveLength(1);
    expect(created[0]!.closed).toBe(false);
  });

  it('closes the 3270 session when the grace window expires', () => {
    const { factory, created } = makeFactory();
    const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 16 });
    const a = reg.attach(undefined);
    reg.detach(a.id);
    vi.advanceTimersByTime(60_001);
    expect(created[0]!.closed).toBe(true);
    expect(reg.attach(a.id).created).toBe(true);   // and it is gone
  });

  it('cancels the grace timer on reattach, so a later tick cannot kill a live session', () => {
    // The bug this catches: keeping the timer and letting it fire after reattachment, which would
    // drop the operator's session mid-use some seconds after a successful reconnect.
    const { factory, created } = makeFactory();
    const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 16 });
    const a = reg.attach(undefined);
    reg.detach(a.id);
    vi.advanceTimersByTime(30_000);
    reg.attach(a.id);
    vi.advanceTimersByTime(60_000);
    expect(created[0]!.closed).toBe(false);
  });

  it('refuses to exceed maxSessions, and says so', () => {
    const { factory } = makeFactory();
    const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 2 });
    reg.attach(undefined);
    reg.attach(undefined);
    expect(() => reg.attach(undefined)).toThrow(/too many/i);
  });

  it('counts a detached session against the cap until it expires', () => {
    // It still holds a socket to the host, so it is still a resource.
    const { factory } = makeFactory();
    const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 1 });
    const a = reg.attach(undefined);
    reg.detach(a.id);
    expect(() => reg.attach(undefined)).toThrow(/too many/i);
    vi.advanceTimersByTime(60_001);
    expect(reg.attach(undefined).created).toBe(true);
  });

  it('gives two concurrent clients two independent sessions', () => {
    const { factory, created } = makeFactory();
    const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 16 });
    const a = reg.attach(undefined);
    const b = reg.attach(undefined);
    expect(a.id).not.toBe(b.id);
    expect(created).toHaveLength(2);
  });

  it('closeAll closes every session, live or detached', () => {
    const { factory, created } = makeFactory();
    const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 16 });
    const a = reg.attach(undefined);
    reg.attach(undefined);
    reg.detach(a.id);
    reg.closeAll();
    expect(created.every((s) => s.closed)).toBe(true);
  });

  /**
   * The reconnect storm. A flapping wifi link detaches and reattaches the same id repeatedly, and
   * a second `detach` can arrive for an already-detached session (the socket's `close` and `error`
   * both firing, say). Each cycle arms a timer whose closure captures the entry, so the question
   * is whether a stale closure from cycle N can reap the session the operator is using in cycle
   * N+1. It must not: only ONE timer may be outstanding per entry at any moment.
   */
  describe('under a reconnect storm', () => {
    it('survives repeated detach/reattach cycles with exactly one timer outstanding', () => {
      const { factory, created } = makeFactory();
      const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 1 });
      const a = reg.attach(undefined);
      for (let cycle = 0; cycle < 5; cycle += 1) {
        reg.detach(a.id);
        expect(vi.getTimerCount()).toBe(1);   // never two reapers for one entry
        vi.advanceTimersByTime(10_000);
        expect(reg.attach(a.id).created).toBe(false);
        expect(vi.getTimerCount()).toBe(0);   // and the reaper is disarmed while attached
      }
      // 50s of wall clock elapsed across the cycles, none of it fatal: the window is per detach,
      // not a cumulative budget, so a flapping link never accumulates its way to a kill.
      vi.advanceTimersByTime(60_000);
      expect(created[0]!.closed).toBe(false);
      expect(created).toHaveLength(1);
    });

    it('treats a second detach of an already-detached session as a no-op', () => {
      // Two timers would mean two `close()` calls and a `delete` of whatever holds the id later.
      const { factory, created } = makeFactory();
      const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 16 });
      const a = reg.attach(undefined);
      reg.detach(a.id);
      vi.advanceTimersByTime(30_000);
      reg.detach(a.id);                       // duplicate close notification
      expect(vi.getTimerCount()).toBe(1);
      // The window is NOT extended by the duplicate: it still expires 60s after the FIRST detach.
      vi.advanceTimersByTime(30_001);
      expect(created[0]!.closed).toBe(true);
      expect(created[0]!.closes).toBe(1);
    });

    it('does not let an expired session\'s reaper disturb its replacement', () => {
      const { factory, created } = makeFactory();
      const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 1 });
      const a = reg.attach(undefined);
      reg.detach(a.id);
      vi.advanceTimersByTime(60_001);         // a is reaped, freeing the single slot
      const b = reg.attach(a.id);             // stale id -> a brand new session
      expect(b.created).toBe(true);
      expect(b.id).not.toBe(a.id);
      vi.advanceTimersByTime(600_000);
      expect(created[1]!.closed).toBe(false); // the replacement is untouched
      expect(vi.getTimerCount()).toBe(0);
    });

    it('leaves no timer behind after closeAll, so the process can exit', () => {
      const { factory } = makeFactory();
      const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 16 });
      const a = reg.attach(undefined);
      reg.detach(a.id);
      expect(vi.getTimerCount()).toBe(1);
      reg.closeAll();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('does not hand a second client the session another client is already using', () => {
    // An ATTACHED id is not reattachable: a leaked id must not become a way to watch, or type
    // into, somebody else's logged-on session. The caller gets a fresh session instead.
    const { factory, created } = makeFactory();
    const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 16 });
    const a = reg.attach(undefined);
    const b = reg.attach(a.id);
    expect(b.created).toBe(true);
    expect(b.id).not.toBe(a.id);
    expect(created).toHaveLength(2);
  });
});
