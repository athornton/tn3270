import { describe, it, expect, vi } from 'vitest';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { defaultSession } from '../src/session.js';
import type { TlsOptions } from '../src/tls.js';

/**
 * `defaultSession`'s geometry mode (Task 4 of the oversize plan; spec
 * docs/superpowers/specs/2026-11-04-oversize-and-model-switching-design.md). None of
 * these connect -- `Session`'s constructor alone is enough to observe `geometrySetting`
 * and `screen.alternateSize`. The TLS-choice tests below DO connect, over a loopback
 * server, because the first byte on the wire is the only witness of which scheme was
 * dialled.
 */

describe('defaultSession geometry mode', () => {
  it('passes the setting through, resolving the model\'s alternate size', () => {
    const session = defaultSession(
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { setting: { model: '3278-4-E', oversize: { kind: 'none' } } },
    );
    expect(session.geometrySetting).toEqual({ model: '3278-4-E', oversize: { kind: 'none' } });
    expect(session.screen.alternateSize).toEqual({ rows: 43, cols: 80 });
  });

  it('does not call measure merely to construct -- only a connect resolves auto', () => {
    const measure = vi.fn(() => ({ rows: 50, cols: 100 }));
    defaultSession(
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { setting: { model: '3278-2-E', oversize: { kind: 'auto' } }, measure },
    );
    expect(measure).not.toHaveBeenCalled();
  });
});

/**
 * A throwaway server that opens with IAC DO TERMINAL-TYPE and records the FIRST bytes each client
 * sends, then hangs up. A plaintext client answers IAC WILL TERMINAL-TYPE (ff fb 18); a TLS client
 * sends a ClientHello, whose first byte is the handshake record type 0x16. So the first byte says
 * which the session dialled, which a TCP connection alone cannot.
 *
 * `close()` destroys every socket it has ever accepted before closing the server, because
 * `srv.close()`'s callback fires only once every connection has ended -- a client that connected
 * but never sent (a bug this test exists to catch) would otherwise hang the test's `finally`
 * forever instead of failing it.
 */
async function firstByteServer(): Promise<{ port: number; firsts: number[]; close(): Promise<void> }> {
  const firsts: number[] = [];
  const socks: Socket[] = [];
  const srv = createServer((sock) => {
    socks.push(sock);
    sock.write(Buffer.from([0xff, 0xfd, 0x18]));
    sock.once('data', (b: Buffer) => { firsts.push(b[0]!); sock.destroy(); });
    sock.on('error', () => { /* the client may reset first */ });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: (srv.address() as AddressInfo).port,
    firsts,
    close: () => {
      for (const sock of socks) sock.destroy();
      return new Promise((r) => srv.close(() => r()));
    },
  };
}

/**
 * Polls `cond` instead of hanging on it. THROWS, naming what it waited for, rather than letting a
 * regression surface as vitest's own "Test timed out" -- which would not say which `until` call
 * was the one still waiting. 2000 ms is comfortably under vitest's default 5000 ms test timeout, so
 * a hang is this error, not that one.
 */
const until = async (what: string, cond: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

describe('defaultSession TLS choice', () => {
  it('a function is read at EACH connect, so a changed choice is the next dial', async () => {
    const srv = await firstByteServer();
    let session: ReturnType<typeof defaultSession> | undefined;
    try {
      let choice: TlsOptions = { kind: 'plaintext' };
      session = defaultSession(undefined, () => choice);
      await session.connect('127.0.0.1', srv.port);
      await until('the plaintext connect\'s first byte', () => srv.firsts.length === 1);
      choice = { kind: 'tls', verify: false };
      // The server destroys the socket the instant it sees the ClientHello, mid-handshake, so the
      // TLS connect reliably rejects -- there is no path where it instead completes or hangs.
      await expect(session.connect('127.0.0.1', srv.port)).rejects.toThrow();
      await until('the TLS connect\'s first byte', () => srv.firsts.length === 2);
      expect(srv.firsts).toEqual([0xff, 0x16]);
    } finally {
      session?.disconnect();
      await srv.close();
    }
  });

  it('a plain TlsOptions is fixed for the session, as before', async () => {
    const srv = await firstByteServer();
    let session: ReturnType<typeof defaultSession> | undefined;
    try {
      session = defaultSession(undefined, { kind: 'plaintext' });
      await session.connect('127.0.0.1', srv.port);
      await until('the first connect\'s first byte', () => srv.firsts.length === 1);
      await session.connect('127.0.0.1', srv.port);
      await until('the second connect\'s first byte', () => srv.firsts.length === 2);
      expect(srv.firsts).toEqual([0xff, 0xff]);
    } finally {
      session?.disconnect();
      await srv.close();
    }
  });
});
