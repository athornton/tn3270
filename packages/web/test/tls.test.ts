import { describe, it, expect, afterEach } from 'vitest';
import { connect as tlsConnect } from 'node:tls';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/main.js';
import { parseWebArgs } from '../src/args.js';
// A TEST-ONLY RELATIVE IMPORT, and deliberately not a package dependency. `gen-test-certs.mjs`
// imports nothing but node builtins, so reaching it by path adds no edge to the workspace graph and
// does not invert `core <- frontend <- {cli, tui}`. Moving the script would break the paths
// `docs/live-testing.md` documents for the TLS runbook, which is a worse trade.
import { generateCerts, haveOpenssl } from '../../cli/scripts/gen-test-certs.mjs';

/**
 * `wss://`, with a certificate generated minutes ago.
 *
 * WHY A HAND-ROLLED CLIENT HERE AND NOT NODE'S: Node's built-in WebSocket constructor takes ONE
 * argument and ignores an options object, so it cannot be given a CA and cannot verify a
 * self-signed certificate. `NODE_EXTRA_CA_CERTS` would have to be set before the process starts,
 * which a test cannot do to itself. So this speaks the handshake over `tls.connect({ ca })`.
 *
 * NOTHING IS COMMITTED. A certificate in the repo expires and reddens the suite on a date nobody
 * chose, in a commit that did not touch TLS.
 */
const trace = join(process.cwd(), 'packages/fixtures/traces/synthetic-ispf-like.trace');
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; });

describe.skipIf(!haveOpenssl())('the gateway over TLS', () => {
  it('serves wss:// and completes a handshake against a pinned CA', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tn3270-web-tls-'));
    const certs = generateCerts(dir);
    const args = parseWebArgs([
      '--replay', trace, '--listen', '0',
      '--tls-cert', certs.certPath, '--tls-key', certs.keyPath, '127.0.0.1:3270',
    ]);
    const { server, registry } = buildServer(args);
    await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
    const port = (server.address() as { port: number }).port;
    stop = () => { registry.closeAll(); server.close(); };

    const key = randomBytes(16).toString('base64');
    // 127.0.0.1 verifies because the generated cert carries `IP:127.0.0.1` in its SAN as well as
    // `DNS:localhost`; its CN alone would not match the address this test connects to.
    const socket = tlsConnect({ host: '127.0.0.1', port, ca: readFileSync(certs.certPath) });
    await new Promise<void>((r, j) => { socket.once('secureConnect', r); socket.once('error', j); });
    // `authorized` is the assertion that matters: "it connected" cannot tell a verified chain from
    // an ignored one, which is a distinction this project has been bitten by before.
    expect(socket.authorized).toBe(true);

    socket.write(
      `GET /ws?t=${args.token} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n`
      + `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );

    const head = await new Promise<string>((r) => {
      let buf = '';
      socket.on('data', function onData(d: Buffer) {
        buf += d.toString('latin1');
        if (buf.includes('\r\n\r\n')) { socket.off('data', onData); r(buf); }
      });
    });
    expect(head).toMatch(/^HTTP\/1\.1 101 /);
    const want = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    expect(head).toContain(`Sec-WebSocket-Accept: ${want}`);
    socket.destroy();
  });

  it('refuses --tls-cert without --tls-key at parse time', () => {
    expect(() => parseWebArgs(['--tls-cert', '/tmp/x', '127.0.0.1:3270'])).toThrow(/--tls-key/);
  });
});
