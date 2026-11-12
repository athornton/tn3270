import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * The TLS path's two deadlines -- the 30 s CONNECT deadline and the 10 s HANDSHAKE deadline -- with
 * `node:tls`'s `connect` (and `node:net`'s `createConnection`, for the plaintext comparison)
 * replaced by sockets that connect only when told to. A real blackholed address is not used, for
 * the reason plainConnectTimeout.test.ts gives: whether a SYN to TEST-NET hangs depends on the
 * runner's network.
 *
 * THE BUG THIS PINS (README audit, 2026-11-12): the TLS socket was bounded only by `tls.connect`'s
 * `timeout` option, which Node arms when the socket is CREATED, before the TCP connect. So a host
 * that never answered the SYN was reported after 10 s as "accepted the connection but never
 * completed a TLS handshake" -- it had accepted nothing -- where `-insecure` said "cannot connect
 * ... no answer within 30 s". The fake below models that option faithfully (an inactivity timer
 * armed at creation, measured 2026-11-12 to fire while `connecting` is still true), so the bug is
 * reproducible here and not merely absent by construction.
 */
class FakeSocket extends EventEmitter {
  destroyed = false;
  private idle: ReturnType<typeof setTimeout> | undefined;
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.setTimeout(0);
    this.emit('close');
  }
  write(): boolean { return true; }
  setTimeout(ms: number): this {
    if (this.idle !== undefined) clearTimeout(this.idle);
    this.idle = ms > 0 ? setTimeout(() => this.emit('timeout'), ms) : undefined;
    return this;
  }
}

let tlsSockets: FakeSocket[] = [];
let netSockets: FakeSocket[] = [];
vi.mock('node:tls', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:tls')>();
  return {
    ...real,
    connect: vi.fn((opts: { timeout?: number }) => {
      const s = new FakeSocket();
      if (opts.timeout !== undefined) s.setTimeout(opts.timeout);   // what Node does with it
      tlsSockets.push(s);
      return s;
    }),
  };
});
vi.mock('node:net', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:net')>();
  return {
    ...real,
    createConnection: vi.fn(() => { const s = new FakeSocket(); netSockets.push(s); return s; }),
  };
});

const {
  tcpConnect, describeConnectError, describeTlsError, CONNECT_TIMEOUT_MS, HANDSHAKE_TIMEOUT_MS,
} = await import('../src/tls.js');

const TLS = { kind: 'tls', verify: true } as const;
const settle = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => e);
const REMEDIES = ['flag', 'dialog', 'prompt'] as const;

beforeEach(() => { tlsSockets = []; netSockets = []; vi.useRealTimers(); });

describe('tcpConnect with TLS: the TCP connect has its own 30 s deadline', () => {
  it('a TCP connect that never completes rejects with CONNECT_TIMEOUT at 30 s, worded as a connect failure', async () => {
    vi.useFakeTimers();
    let done = false;
    const p = settle(tcpConnect('192.0.2.1', 23, TLS)).finally(() => { done = true; });
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    expect(done, 'settled before the 30 s connect deadline').toBe(false);
    expect(tlsSockets[0]!.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe('CONNECT_TIMEOUT');
    expect((err as Error).message)
      .toBe('cannot connect to 192.0.2.1:23: no answer within 30 s (CONNECT_TIMEOUT)');
    expect((err as Error).message).not.toContain('TLS');
    expect(tlsSockets[0]!.destroyed).toBe(true);
    // Every front end re-describes from the code; none may turn it back into a TLS message.
    for (const remedy of REMEDIES) {
      expect(describeTlsError('CONNECT_TIMEOUT', '192.0.2.1', 23, remedy))
        .toBe(describeConnectError('CONNECT_TIMEOUT', '192.0.2.1', 23));
    }
  });

  it('reports exactly what the plaintext path reports for the same unanswered connect', async () => {
    vi.useFakeTimers();
    const tls = settle(tcpConnect('192.0.2.1', 23, TLS));
    const plain = settle(tcpConnect('192.0.2.1', 23, { kind: 'plaintext' }));
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    const [t, p] = await Promise.all([tls, plain]) as [Error & { code?: string }, Error & { code?: string }];
    expect(t.code).toBe(p.code);
    expect(t.message).toBe(p.message);
  });
});

describe('tcpConnect with TLS: the 10 s handshake deadline starts at the TCP connect', () => {
  it('a host that accepts TCP and never handshakes gets HANDSHAKE_TIMEOUT 10 s after the connect', async () => {
    vi.useFakeTimers();
    let done = false;
    const p = settle(tcpConnect('herc', 3270, TLS)).finally(() => { done = true; });
    // Connect late, at 25 s: a connect deadline left armed would fire at 30 s, inside the
    // handshake window, and a handshake deadline counted from creation would have fired at 10 s.
    const connectAt = 25_000;
    await vi.advanceTimersByTimeAsync(connectAt);
    expect(done).toBe(false);
    tlsSockets[0]!.emit('connect');
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS - 1);
    expect(done, 'settled before the handshake deadline').toBe(false);
    expect(tlsSockets[0]!.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await p;
    expect((err as { code?: string }).code).toBe('HANDSHAKE_TIMEOUT');
    expect((err as Error).message).toBe(describeTlsError('HANDSHAKE_TIMEOUT', 'herc', 3270));
    expect((err as Error).message).toContain('accepted the connection but never completed a TLS handshake');
    expect(tlsSockets[0]!.destroyed).toBe(true);
  });

  it('a completed handshake disarms both deadlines, so an idle session is never dropped', async () => {
    vi.useFakeTimers();
    const p = tcpConnect('herc', 3270, TLS);
    tlsSockets[0]!.emit('connect');
    tlsSockets[0]!.emit('secureConnect');
    const conn = await p;
    expect(vi.getTimerCount(), 'a deadline is still armed on a live session').toBe(0);
    let closed = false;
    conn.onClose = () => { closed = true; };
    await vi.advanceTimersByTimeAsync((CONNECT_TIMEOUT_MS + HANDSHAKE_TIMEOUT_MS) * 4);
    expect(tlsSockets[0]!.destroyed).toBe(false);
    expect(closed).toBe(false);
  });
});

describe('tcpConnect with TLS: a refused connect reads exactly as it does without TLS', () => {
  it('ECONNREFUSED gets the plaintext wording and code, and no deadline fires afterwards', async () => {
    vi.useFakeTimers();
    const tls = settle(tcpConnect('herc', 1, TLS));
    const plain = settle(tcpConnect('herc', 1, { kind: 'plaintext' }));
    const refused = () => Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:1'), { code: 'ECONNREFUSED' });
    tlsSockets[0]!.emit('error', refused());
    netSockets[0]!.emit('error', refused());
    const t = await tls as Error & { code?: string };
    const p = await plain as Error & { code?: string };
    expect(t.code).toBe('ECONNREFUSED');
    expect(t.code).toBe(p.code);
    // The plaintext path rejects with Node's own error and each front end words it with
    // describeConnectError; the TLS path words it in tcpConnect. The result must be the same.
    const plainWords = describeConnectError(p.code, 'herc', 1, p.message);
    expect(t.message).toBe(plainWords);
    expect(t.message).toBe('cannot connect to herc:1: connection refused (ECONNREFUSED)');
    for (const remedy of REMEDIES) expect(describeTlsError(t.code, 'herc', 1, remedy)).toBe(plainWords);
    expect(vi.getTimerCount(), 'a deadline outlived the failure').toBe(0);
  });
});
