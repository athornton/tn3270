import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * TLS went on by default in 6337c99 and NOTHING CAUGHT THAT IT BROKE THE HARNESSES.
 * `pty-smoke.py` went from 12/12 to 1/12 and `live-drive.py` could no longer reach
 * either Hercules system, because a plaintext host does not reject a TLS handshake --
 * it goes quiet -- so the symptom is a stall, not an error naming the cause.
 *
 * The reason it went unnoticed is structural: both harnesses need a real pty and a
 * fork, so neither runs under `npm test`, and the only thing standing between a
 * default-flipping change and a silently dead harness was someone remembering. The
 * project notes had even predicted this trap for the *conformance* harness and these
 * two were still missed.
 *
 * So this test reads the scripts as text and pins the one flag whose absence disables
 * the whole run. It does not run them; it asserts they are still invoked in a way that
 * can work against the hosts they exist to drive. If a harness is ever pointed at a
 * host that speaks TLS, delete its case here rather than weakening the assertion.
 */
const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

describe('live harnesses target plaintext Hercules', () => {
  for (const script of ['pty-smoke.py', 'live-drive.py']) {
    it(`${script} passes -insecure to the client`, () => {
      const source = readFileSync(join(scriptsDir, script), 'utf8');

      // Anchor on the argv list that actually execs the client, not on the file
      // anywhere: a comment mentioning -insecure must not satisfy this.
      const argv = source.match(/argv = \[[^\]]*\]/s);
      expect(argv, `no argv list found in ${script}`).not.toBeNull();
      expect(argv![0]).toContain('dist/main.js');
      expect(argv![0]).toContain('"-insecure"');
    });
  }
});
