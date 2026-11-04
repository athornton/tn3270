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
  /**
   * THE BROWSER VIEWPORT, for `-oversize auto` (2026-11-04). The session's measure reads whatever
   * the handle was last told, so the registry must tell it about the tab CURRENTLY attached: a
   * new session gets hello's viewport at construction (it connects inside the factory), a
   * reattaching tab REPLACES it, and a hijack attempt -- which falls through to a new session --
   * must not touch the session it failed to take.
   */
  describe('the viewport', () => {
    const makeViewportFactory = () => {
      const made: Array<{ id: string; initial: unknown; viewports: unknown[] }> = [];
      const factory = (id: string, viewport: unknown) => {
        const m = { id, initial: viewport, viewports: [] as unknown[] };
        made.push(m);
        return {
          session: m as never,
          close: () => {},
          setViewport: (v: unknown) => { m.viewports.push(v); },
        };
      };
      return { factory, made };
    };

    it('hands a NEW session hello\'s viewport at construction, before it can connect', () => {
      const { factory, made } = makeViewportFactory();
      const reg = new SessionRegistry({ factory: factory as never, graceMs: 60_000, maxSessions: 16 });
      reg.attach(undefined, { width: 1350, height: 980 });
      expect(made[0]!.initial).toEqual({ width: 1350, height: 980 });
      reg.attach(undefined);
      expect(made[1]!.initial).toBeUndefined();
    });

    it('REPLACES the viewport when a tab reattaches, with whatever that tab sent', () => {
      const { factory, made } = makeViewportFactory();
      const reg = new SessionRegistry({ factory: factory as never, graceMs: 60_000, maxSessions: 16 });
      const a = reg.attach(undefined, { width: 1350, height: 980 });
      reg.detach(a.id);
      reg.attach(a.id, { width: 900, height: 700 });
      expect(made[0]!.viewports).toEqual([{ width: 900, height: 700 }]);
      // A reattaching tab that sent none leaves the session with none: the measure must not read
      // a window that is no longer attached.
      reg.detach(a.id);
      reg.attach(a.id);
      expect(made[0]!.viewports).toEqual([{ width: 900, height: 700 }, undefined]);
    });

    it('does NOT touch the viewport of a session another tab holds', () => {
      const { factory, made } = makeViewportFactory();
      const reg = new SessionRegistry({ factory: factory as never, graceMs: 60_000, maxSessions: 16 });
      const a = reg.attach(undefined, { width: 1350, height: 980 });
      const b = reg.attach(a.id, { width: 100, height: 100 });
      expect(b.created).toBe(true);
      expect(made[0]!.viewports).toEqual([]);
      expect(made[1]!.initial).toEqual({ width: 100, height: 100 });
    });

    it('gives the attacher a setViewport for its OWN session, for the resize message', () => {
      const { factory, made } = makeViewportFactory();
      const reg = new SessionRegistry({ factory: factory as never, graceMs: 60_000, maxSessions: 16 });
      const a = reg.attach(undefined);
      const b = reg.attach(undefined);
      b.setViewport({ width: 640, height: 480 });
      a.setViewport({ width: 320, height: 240 });
      expect(made[0]!.viewports).toEqual([{ width: 320, height: 240 }]);
      expect(made[1]!.viewports).toEqual([{ width: 640, height: 480 }]);
    });

    it('tolerates a handle with no setViewport, which is what the lifecycle fakes above are', () => {
      const { factory } = makeFactory();
      const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 16 });
      const a = reg.attach(undefined, { width: 1, height: 1 });
      expect(() => { a.setViewport({ width: 2, height: 2 }); }).not.toThrow();
      reg.detach(a.id);
      expect(() => reg.attach(a.id, { width: 3, height: 3 })).not.toThrow();
    });
  });
});
