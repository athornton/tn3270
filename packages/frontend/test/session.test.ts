import { describe, it, expect, vi } from 'vitest';
import { createServer, type AddressInfo } from 'node:net';
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
 */
async function firstByteServer(): Promise<{ port: number; firsts: number[]; close(): Promise<void> }> {
  const firsts: number[] = [];
  const srv = createServer((sock) => {
    sock.write(Buffer.from([0xff, 0xfd, 0x18]));
    sock.once('data', (b: Buffer) => { firsts.push(b[0]!); sock.destroy(); });
    sock.on('error', () => { /* the client may reset first */ });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: (srv.address() as AddressInfo).port,
    firsts,
    close: () => new Promise((r) => srv.close(() => r())),
  };
}

const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

describe('defaultSession TLS choice', () => {
  it('a function is read at EACH connect, so a changed choice is the next dial', async () => {
    const srv = await firstByteServer();
    try {
      let choice: TlsOptions = { kind: 'plaintext' };
      const session = defaultSession(undefined, () => choice);
      await session.connect('127.0.0.1', srv.port);
      await until(() => srv.firsts.length === 1);
      choice = { kind: 'tls', verify: false };
      await session.connect('127.0.0.1', srv.port).catch(() => { /* hung up mid-handshake */ });
      await until(() => srv.firsts.length === 2);
      expect(srv.firsts).toEqual([0xff, 0x16]);
    } finally { await srv.close(); }
  });

  it('a plain TlsOptions is fixed for the session, as before', async () => {
    const srv = await firstByteServer();
    try {
      const session = defaultSession(undefined, { kind: 'plaintext' });
      await session.connect('127.0.0.1', srv.port);
      await until(() => srv.firsts.length === 1);
      await session.connect('127.0.0.1', srv.port);
      await until(() => srv.firsts.length === 2);
      expect(srv.firsts).toEqual([0xff, 0xff]);
    } finally { await srv.close(); }
  });
});
