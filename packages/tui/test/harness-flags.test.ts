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
const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(here, '..', 'scripts');
const cliScriptsDir = join(here, '..', '..', 'cli', 'scripts');

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

/**
 * The TN3270E harness needs the same flag for a different reason: `e-server.py` is
 * plaintext because it is a protocol mimic, not because the host it stands in for is.
 * The failure mode is identical, and worse here — a stalled handshake in a harness
 * whose whole job is to decide whether OUR negotiation is correct would read as a
 * negotiation bug.
 *
 * A different shape from the two above, so it is checked differently rather than being
 * forced into the same regex: drive-e.py holds the flag in one constant and spreads it
 * into every case's argv. BOTH halves are pinned — the constant's contents and the
 * spread — because either alone can be removed while the other still reads correctly.
 */
describe('the TN3270E harness driver', () => {
  const source = readFileSync(join(cliScriptsDir, 'drive-e.py'), 'utf8');

  it('keeps -insecure in the flags it passes to every case', () => {
    const flags = source.match(/^REQUIRED_FLAGS = \[[^\]]*\]/m);
    expect(flags, 'no REQUIRED_FLAGS list found in drive-e.py').not.toBeNull();
    expect(flags![0]).toContain("'-insecure'");
  });

  it('actually spreads those flags into the argv that execs the client', () => {
    // Without this half, REQUIRED_FLAGS could keep saying -insecure while nothing
    // passed it -- the test would stay green over a harness that hangs.
    const run = source.match(/\[node, CLI,[^\]]*\]/s);
    expect(run, 'no client invocation found in drive-e.py').not.toBeNull();
    expect(run![0]).toContain('*REQUIRED_FLAGS');
  });
});

/**
 * `drive-playback.py` needs -insecure for the same reason drive-e.py does: playback is
 * a plaintext replayer, and a TLS handshake against it STALLS rather than failing.
 *
 * IT ALSO NEEDS TWO THINGS NOTHING ELSE IN THIS REPO NEEDS, and both were learned by
 * the harness reporting our client broken when it was not:
 *
 * 1. It must NOT probe the port by connecting. `playback` accepts one connection at a
 *    time, so a readiness probe is accepted AS the emulator and the real client is
 *    never served -- a false "0 of 5 cases passed" indistinguishable from a client
 *    that connects and says nothing. The same defect once made drive-e.py fail all
 *    seven of its cases.
 * 2. It must assert on `Matched N bytes`, NOT on playback's exit status.
 *    `Common/playback.c:373` is `exit(0); /* needs to be smarter *\/` -- a run that
 *    matched nothing exits 0 exactly like a run that matched everything.
 *
 * Each is pinned as an ABSENCE or a PRESENCE in the source text, because both failure
 * modes are green-looking: the harness still prints, still exits 0, and still says
 * "passed".
 */
describe('the playback oracle driver', () => {
  const source = readFileSync(join(cliScriptsDir, 'drive-playback.py'), 'utf8');

  it('keeps -insecure in the flags it passes to every case', () => {
    const flags = source.match(/^REQUIRED_FLAGS = \[[^\]]*\]/m);
    expect(flags, 'no REQUIRED_FLAGS list found in drive-playback.py').not.toBeNull();
    expect(flags![0]).toContain("'-insecure'");
  });

  it('concatenates those flags into the argv that execs the client', () => {
    // Match to end of line, NOT `[^\]]*`: this argv is a concatenation of three lists,
    // so a bracket-stopping pattern truncates at `[node, CLI]` and the assertion fails
    // over a correct harness. It did, first time.
    const run = source.match(/^\s*client_argv = .*$/m);
    expect(run, 'no client invocation found in drive-playback.py').not.toBeNull();
    expect(run![0]).toContain('REQUIRED_FLAGS');
    expect(run![0]).toContain('CLI');
  });

  it('never opens a connection to the port it is waiting on', () => {
    // create_connection to the playback port is the specific mistake. Allow it
    // nowhere in the file: free_port() binds a socket to find a free port and closes
    // it, which is a bind and not a connect, so this stays precise.
    expect(source).not.toMatch(/create_connection/);
  });

  it('asserts on matched-byte lines rather than playback\'s exit status', () => {
    expect(source).toContain('Matched (\\d+) bytes from emulator');
    // returncode would be the natural thing to check and is worthless here.
    expect(source).not.toMatch(/pb\.returncode/);
  });
});

/**
 * The DFT transfer scripts, whose two failure modes are both SILENT and both cost a live run.
 *
 * These are s3270 command scripts rather than python drivers, so there is no argv to anchor on
 * -- the assertions are on the command sequence itself. Each pins a fact that was MEASURED on
 * TK5 on 2026-09-29, after a run lost its `LISTDS` steps and its `LOGOFF` to the first and
 * reported `REENTER - IND$FILE PUT ...` with zero DFT frames to the second.
 *
 * WHY A TEST AND NOT JUST THE COMMENT THE SCRIPTS ALREADY CARRY: nothing here runs these
 * scripts (they need a live mainframe), so a well-meant tidy-up that collapsed the per-dataset
 * DELETEs or dropped a `Wait(Unlock)` would leave `npm test` fully green and the next live run
 * would fail in a way that reads as a client bug. That is the same structural gap this file was
 * created for.
 */
describe('the DFT transfer scripts', () => {
  const dftScripts = ['dft-tso.txt', 'dft-lrecl-tso.txt'];

  for (const script of dftScripts) {
    const source = readFileSync(join(cliScriptsDir, script), 'utf8');
    const lines = source.split('\n').map((l) => l.trim());
    const transferAt = lines
      .map((l, i) => (l.startsWith('Transfer(') ? i : -1))
      .filter((i) => i >= 0);

    it(`${script} follows EVERY Transfer() with Wait(Unlock)`, () => {
      // TK5 leaves the screen at 24x80 with the keyboard LOCKED once a DFT transfer
      // completes, so the next String() is refused with `input inhibited` and its step is
      // silently lost. The transfer itself still succeeds, which is what makes this so easy
      // to miss: the log says "Transfer complete" and the step after it simply did not run.
      expect(transferAt.length, `no Transfer() found in ${script}`).toBeGreaterThan(0);
      for (const i of transferAt) {
        expect(lines[i + 1], `Transfer() at line ${i + 1} of ${script} is not followed by Wait(Unlock)`)
          .toMatch(/^Wait\(Unlock/);
      }
    });

    it(`${script} does NOT put Wait(Unlock) in the logon dance`, () => {
      // The opposite error, and it is not symmetrical: Wait(Unlock) before the password
      // advances past TSO's prompt, and the password is then read as a command --
      // `IKJ56410I CUL8TR COMMAND NOT ACCEPTED DURING LOGON`. Plain Wait(Settle) is what
      // works there, so the FIRST Wait(Unlock) must come after the first Transfer().
      const firstUnlock = lines.findIndex((l) => l.startsWith('Wait(Unlock'));
      expect(firstUnlock, `no Wait(Unlock) at all in ${script}`).toBeGreaterThan(0);
      expect(firstUnlock, `${script} waits for Unlock before its first Transfer()`)
        .toBeGreaterThan(transferAt[0]!);
    });

    it(`${script} deletes ONE dataset per DELETE command`, () => {
      // TSO's DELETE takes a single dsname: `DELETE 'A' 'B' 'C'` is INVALID KEYWORD, which
      // leaves TSO at a REENTER prompt that swallows every later command. Counting quoted
      // names is what catches a "tidier" one-line version.
      for (const line of lines.filter((l) => l.startsWith('String("DELETE'))) {
        const names = line.match(/'[^']*'/g) ?? [];
        expect(names.length, `more than one dataset in: ${line}`).toBe(1);
      }
    });
  }

  it('dft-lrecl-tso.txt keeps all THREE Lrecl/Recfm cases, which is what makes it conclusive', () => {
    // A vs B varies only Lrecl; B vs C varies only Recfm. Dropping the third case would leave
    // a script that cannot distinguish a host IGNORING a keyword from a client never SENDING
    // it -- the exact ambiguity the three-case design exists to remove, and it would still
    // look like a passing experiment.
    const source = readFileSync(join(cliScriptsDir, 'dft-lrecl-tso.txt'), 'utf8');
    expect(source).toContain('Recfm=variable,Lrecl=1024');
    expect(source).toContain('Recfm=variable,Lrecl=80');
    expect(source).toContain('Recfm=fixed,Lrecl=80');
    // And a LISTDS per transfer, since TSO's own report is the independent check.
    expect(source.match(/String\("LISTDS /g)?.length).toBe(3);
  });

  it('dft-lrecl-tso.txt uses HERC02, because HERC01 is held', () => {
    // An earlier failed run left HERC01 held (IKJ56425I ... USERID HERC01 IN USE) and a held
    // userid cannot be freed from a fresh logon -- it needs operator action on the Hercules
    // console. Pinned so a copy-paste back to HERC01 is caught here rather than by a live run
    // whose downstream symptom (the password rejected as a command) looks like a client bug.
    const source = readFileSync(join(cliScriptsDir, 'dft-lrecl-tso.txt'), 'utf8');
    expect(source).toContain('String("HERC02")');
    expect(source).not.toContain('String("HERC01")');
  });
});
