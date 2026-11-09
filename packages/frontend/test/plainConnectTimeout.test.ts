import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * The plaintext connect deadline, with `node:net`'s `createConnection` replaced by a socket that
 * connects only when told to. A real blackholed address is NOT used: whether a SYN to TEST-NET
 * hangs or fails at once with EHOSTUNREACH/ENETUNREACH depends on the runner's network, so it
 * would pass or fail by environment. (Measured by hand on 2026-11-09 instead: see tls.ts.)
 */
class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy(): void { this.destroyed = true; this.emit('close'); }
  write(): boolean { return true; }
  setTimeout(): this { return this; }
}

let sockets: FakeSocket[] = [];
vi.mock('node:net', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:net')>();
  return {
    ...real,
    createConnection: vi.fn(() => { const s = new FakeSocket(); sockets.push(s); return s; }),
  };
});

const { tcpConnect, describeConnectError, CONNECT_TIMEOUT_MS } = await import('../src/tls.js');

beforeEach(() => { sockets = []; vi.useRealTimers(); });

describe('tcpConnect plaintext connect deadline', () => {
  it('is 30 seconds by default', () => {
    expect(CONNECT_TIMEOUT_MS).toBe(30_000);
  });

  it('a connect that never completes rejects with CONNECT_TIMEOUT, and the socket is destroyed', async () => {
    vi.useFakeTimers();
    const p = tcpConnect('herc', 3270, { kind: 'plaintext' }).then(() => undefined, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    expect(sockets[0]!.destroyed).toBe(false);          // not a moment early
    await vi.advanceTimersByTimeAsync(1);
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe('CONNECT_TIMEOUT');
    expect((err as Error).message).toBe(describeConnectError('CONNECT_TIMEOUT', 'herc', 3270));
    expect(sockets[0]!.destroyed).toBe(true);
  });

  it('the deadline is DISARMED by the connect, so an idle session is never dropped by it', async () => {
    // The trap the TLS path documents: a 3270 session is idle while the operator reads the screen.
    vi.useFakeTimers();
    const p = tcpConnect('herc', 3270, { kind: 'plaintext' });
    sockets[0]!.emit('connect');
    const conn = await p;
    let closed = false;
    conn.onClose = () => { closed = true; };
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS * 4);
    expect(sockets[0]!.destroyed).toBe(false);
    expect(closed).toBe(false);
  });

  it('a socket error before the deadline rejects with that error, and the deadline cannot fire later', async () => {
    vi.useFakeTimers();
    const p = tcpConnect('herc', 1, { kind: 'plaintext' }).then(() => undefined, (e: unknown) => e);
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    sockets[0]!.emit('error', refused);
    expect(await p).toBe(refused);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS * 2);
    expect(sockets[0]!.destroyed).toBe(false);          // the timer did not come back to destroy it
  });

  it('honours a shorter deadline when one is passed', async () => {
    vi.useFakeTimers();
    const p = tcpConnect('herc', 3270, { kind: 'plaintext' }, undefined, 500)
      .then(() => undefined, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(500);
    expect(((await p) as { code?: string }).code).toBe('CONNECT_TIMEOUT');
  });
});

describe("describeConnectError's words for the deadline", () => {
  it('says how long it waited, action and target first', () => {
    expect(describeConnectError('CONNECT_TIMEOUT', 'herc', 3270))
      .toBe('cannot connect to herc:3270: no answer within 30 s (CONNECT_TIMEOUT)');
  });
});
