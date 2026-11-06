import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Guards the CONNECT harness's invocation, which `npm test` cannot run.
 *
 * Same reasoning as its siblings (`transfer-harness-flags.test.ts` has the whole argument): a
 * harness outside the fast gate is exempt from every change until somebody remembers it. This reads
 * `connect.mjs` as TEXT and pins the things whose absence would disable it SILENTLY. It pins the
 * invocation, not the behavior; the behavior is the by-hand run.
 */
const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const harness = readFileSync(join(guiDir, 'scripts', 'connect.mjs'), 'utf8');
/** Comments stripped, for the absences -- the harness's prose names what it must not do. */
const code = harness.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** The shared smoke helpers the harness imports its server from, comments stripped likewise. */
const libCode = readFileSync(join(guiDir, '..', '..', 'scripts', 'smoke-lib.mjs'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the connect harness', () => {
  it('runs guiMain() and prints which entry it tested', () => {
    expect(harness).toMatch(/const main = guiMain\(\)/);
    expect(harness).toContain('console.log(`entry: ${guiMainLabel()}`)');
  });

  it('refuses a stale dist/ or app/', () => {
    // frontend too: the TLS and refused-connect wording it checks lives in packages/frontend.
    expect(harness).toContain("staleness(main, ['gui', 'frontend', 'canvas'])");
  });

  it('launches with Electron switches only -- no host, no -insecure -- so the dialog opens', () => {
    const argv = /^const ARGV = \[[^\]]*\]/m.exec(harness);
    expect(argv, 'no ARGV list found in connect.mjs').not.toBeNull();
    expect(argv![0]).toContain("'--no-sandbox'");
    expect(argv![0]).toContain("'--disable-gpu'");
    expect(argv![0]).not.toContain("'-insecure'");
    expect(code).toMatch(/spawn\(electron, \[main, \.\.\.ARGV/);
  });

  it('drives the seam it exists to drive, with the inherited seams cleared', () => {
    expect(code).toMatch(/TN3270_GUI_CONNECT:\s*JSON\.stringify\(form\)/);
    expect(code).toMatch(/TN3270_GUI_REPLAY:\s*''/);
    expect(code).toMatch(/TN3270_GUI_SHOT:\s*''/);
  });

  it('proves PLAINTEXT, not merely a connection -- the check the always-TLS mutant fails', () => {
    // The server moved to scripts/smoke-lib.mjs (shared with package-smoke.mjs), so this pins both
    // halves: the harness imports it and checks its reply, and the reply it checks is WILL TTYPE.
    expect(code).toMatch(/import \{[^}]*\bstartServer\b[^}]*\} from '\.\.\/\.\.\/\.\.\/scripts\/smoke-lib\.mjs'/);
    expect(code).toMatch(/\[[^\]]*PLAINTEXT[^\]]*, srv\.willTtype\(\)\]/);
    expect(libCode).toMatch(/willTtype: \(\) => seen\.bytes\.includes\(Buffer\.from\(\[IAC, WILL, TTYPE\]\)\)/);
    expect(libCode).toMatch(/const IAC = 255, DO = 253, WILL = 251, TTYPE = 24;/);
  });

  it('kills by PID and asserts no survivors, never by name', () => {
    expect(code).toMatch(/detached:\s*true/);
    expect(code).toMatch(/process\.kill\(-run\.child\.pid, 'SIGKILL'\)/);
    expect(code).toContain("'no process survived the kill'");
    expect(code).not.toMatch(/pkill/);
  });
});
