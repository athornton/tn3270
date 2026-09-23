import { describe, it, expect, vi } from 'vitest';
import {
  AckAid, AID, resolve, Session, type Connection,
} from '@tn3270/core';
import type { TransferFiles, TransferRequest } from '@tn3270/frontend';
import { startTransfer } from '../src/transferRun.js';

/**
 * Transfer-engine tests over a REAL `Session` with a fake socket.
 *
 * Per `app.test.ts`'s `makeSession`: a fresh unconnected `Session` has a real `Screen`,
 * `Keyboard`, `oia` and real `on`/`off`/`listenerCount`, so these exercise the real objects
 * rather than proving `startTransfer` calls the method the test told it to expect. That is
 * also what makes the listener-leak test meaningful.
 *
 * ## TWO THINGS THE PLAN GOT WRONG ABOUT THE FIXTURES, BOTH MEASURED
 *
 * 1. `new Session({ alternateRows: 43 })` gives a **24x80** screen, not a 43-row one: a
 *    model's `-model` flag sets only the ALTERNATE size and EW/EWA switch to it, so the
 *    DEFAULT stays 24x80. The geometry-refusal test would have passed for entirely the
 *    wrong reason -- the screen really being 1920 cells. `rows`/`cols` are what size the
 *    buffer, and the test asserts `screen.size` before asserting the refusal.
 * 2. `is3270Mode()` is **false** on any unconnected session (`session.ts:295` reads through
 *    `this.telnet?`, which is undefined), so the 3270-mode refusal fires before every other
 *    check. Every test that needs to get past it must mock it true; the plan mocks it only
 *    in the test that wants it false.
 */
function makeSession(rows = 24, cols = 80): Session {
  const conn: Connection = {
    write: () => {}, close: () => {},
    onData: undefined, onClose: undefined, onError: undefined,
  };
  return new Session({ connect: () => conn, rows, cols });
}

/** A session that reports 3270 mode, which is what every non-refusal test needs. */
function in3270(session: Session): Session {
  vi.spyOn(session, 'is3270Mode').mockReturnValue(true);
  return session;
}

/**
 * Record the AIDs a session is asked to send.
 *
 * A SPY, not a fake session: `startTransfer` must drive the real Screen and Keyboard, and
 * the only thing worth intercepting is the wire. `sendAID` rather than `conn.write` because
 * this asserts WHICH AID we asked for -- reading it back out of a framed record would be
 * asserting the telnet layer, which has its own tests.
 */
function withSpy(session: Session): { session: Session; aids: number[] } {
  const aids: number[] = [];
  vi.spyOn(session, 'sendAID').mockImplementation((aid: number) => { aids.push(aid); });
  return { session, aids };
}

/** An in-memory TransferFiles, which is what the injected interface exists for. */
function fakeFiles(
  initial: Record<string, Uint8Array> = {},
): TransferFiles & { files: Map<string, Uint8Array> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    exists: (p) => files.has(p),
    read: (p) => {
      const got = files.get(p);
      if (got === undefined) throw new Error(`ENOENT: ${p}`);
      return got;
    },
    write: (p, bytes) => { files.set(p, bytes); },
    append: (p, bytes) => {
      const old = files.get(p) ?? new Uint8Array(0);
      const out = new Uint8Array(old.length + bytes.length);
      out.set(old); out.set(bytes, old.length);
      files.set(p, out);
    },
  };
}

const aReceive = (localFile = '/tmp/a.bin'): TransferRequest => ({
  direction: 'receive', localFile, hostFile: 'A.BIN',
  host: 'tso', mode: 'binary', cr: 'auto', exist: 'keep',
});

const aSend = (localFile = '/tmp/a.bin'): TransferRequest => ({
  ...aReceive(localFile), direction: 'send',
});

/** The whole screen as text, for checking the command was typed into it. */
function screenText(session: Session): string {
  return resolve(session.screen.snapshot(), {}).map((c) => c.text).join('');
}

/**
 * A screen with one big unprotected field, which is what a host command prompt looks like.
 *
 * `primeAndType`'s port refuses an UNFORMATTED screen -- IND$FILE is typed at a prompt and
 * every host that offers one paints it as a field -- so a bare `new Session()` cannot get
 * past it. Measured, not assumed: without this the "primes the command" test fails with
 * "no input field (screen is unformatted)".
 */
function withField(session: Session): Session {
  session.screen.setFieldAttribute(0, 0x00);   // unprotected, so it accepts typing
  return session;
}

/** The options every test shares, so a test body names only what it varies. */
const base = {
  onProgress: () => {}, onDone: () => {},
};

describe('startTransfer', () => {
  it('REFUSES a screen that is not 24x80, and names the remedy', () => {
    // The refusal must say what to do about it, because the remedy is a RESTART: -model
    // is parsed once at launch and runtime model-switching does not exist. A message that
    // only reports the geometry leaves a user at -model 3278-4-E stuck with no way out
    // from inside the running client.
    const { session } = withSpy(in3270(makeSession(43, 80)));
    // ASSERTED FIRST, because `alternateRows: 43` would have given a 1920-cell screen and
    // this test would then pass for the wrong reason. See the module comment.
    expect(session.screen.size).toBe(3440);
    const r = startTransfer({ ...base, session, files: fakeFiles(), request: aReceive(), command: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/24x80/);
    expect(r.error).toMatch(/43x80/);            // the CURRENT geometry
    expect(r.error).toMatch(/-model 3278-2-E/);  // the remedy
    expect(r.error).toMatch(/DFT/);              // and that it is coming
  });

  it('refuses when not in 3270 mode', () => {
    // No `in3270` here: an unconnected session already reports false, which is the state a
    // TUI is in before it connects.
    const { session } = withSpy(makeSession(24, 80));
    expect(session.is3270Mode()).toBe(false);
    const r = startTransfer({ ...base, session, files: fakeFiles(), request: aReceive(), command: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not in 3270 mode/);
  });

  it('CHECKS GEOMETRY BEFORE 3270 MODE, so a model-4 user is told the useful thing', () => {
    // Both are wrong on a fresh 43-row session, and which message they see decides what
    // they do: "restart with -model 3278-2-E" is actionable, "not in 3270 mode" sends them
    // looking at the connection. The CLI checks geometry first (runner.ts:453) and this
    // pins the same order.
    const { session } = withSpy(makeSession(43, 80));
    const r = startTransfer({ ...base, session, files: fakeFiles(), request: aReceive(), command: 'x' });
    expect(r.error).toMatch(/24x80/);
    expect(r.error).not.toMatch(/not in 3270 mode/);
  });

  it('refuses a receive onto an existing file with Exist=keep, BEFORE telling the host', () => {
    // A local error must fail before the host command is typed, or the host is left in
    // transfer mode waiting for a client that has already given up.
    const { session, aids } = withSpy(withField(in3270(makeSession(24, 80))));
    const files = fakeFiles({ '/tmp/a.bin': new Uint8Array([1]) });
    const r = startTransfer({ ...base, session, files, request: aReceive('/tmp/a.bin'), command: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/file exists/);
    expect(aids).toEqual([]);                    // nothing reached the host
    expect(screenText(session)).not.toContain('x');  // and nothing was typed either
  });

  it('refuses a send whose source cannot be read, BEFORE telling the host', () => {
    const { session, aids } = withSpy(withField(in3270(makeSession(24, 80))));
    const r = startTransfer({
      ...base, session, files: fakeFiles(), request: aSend('/tmp/missing'), command: 'x',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot read local file/);
    expect(aids).toEqual([]);
  });

  it('REFUSES AN UNFORMATTED SCREEN rather than typing into a logon banner', () => {
    // The CLI's reasoning, ported: x3270 guesses at a run of nulls from the cursor
    // (kybd.c:4389-4403); we refuse, because an unformatted screen here means the operator
    // is somewhere they did not think they were -- a VM/370 logon banner, say. Failing is
    // recoverable; typing a transfer command into a logon screen is not.
    const { session, aids } = withSpy(in3270(makeSession(24, 80)));   // no withField
    const r = startTransfer({ ...base, session, files: fakeFiles(), request: aReceive(), command: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unformatted/);
    expect(aids).toEqual([]);
  });

  it('primes the command and sends Enter when every local check passes', () => {
    const { session, aids } = withSpy(withField(in3270(makeSession(24, 80))));
    const r = startTransfer({
      ...base, session, files: fakeFiles(), request: aReceive(), command: 'IND$FILE GET A.BIN',
    });
    expect(r.ok).toBe(true);
    expect(screenText(session)).toContain('IND$FILE GET A.BIN');
    expect(aids).toEqual([AID.ENTER]);
  });

  it('times out rather than hanging when no frame arrives', async () => {
    vi.useFakeTimers();
    try {
      const { session } = withSpy(withField(in3270(makeSession(24, 80))));
      let done: { ok: boolean; error?: string } | undefined;
      startTransfer({
        session, files: fakeFiles(), request: aReceive(), command: 'x',
        onProgress: () => {}, onDone: (d) => { done = d; }, frameMs: 1000, totalMs: 5000,
      });
      await vi.advanceTimersByTimeAsync(1200);
      expect(done?.ok).toBe(false);
      expect(done?.error).toMatch(/within/);
      // The host may STILL be in transfer mode, and the message must say so -- otherwise
      // the user's next keystroke goes into a host waiting for a CUT frame.
      expect(done?.error).toMatch(/Attn or Clear/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CANCELS by aborting, so the host leaves transfer mode', () => {
    const { session, aids } = withSpy(withField(in3270(makeSession(24, 80))));
    const run = startTransfer({ ...base, session, files: fakeFiles(), request: aReceive(), command: 'x' });
    expect(run.ok).toBe(true);
    run.cancel!();
    // PF2: an abort WE initiate. Abandoning instead would leave the host program waiting.
    expect(aids).toEqual([AID.ENTER, AckAid.ABORT]);
  });

  it('a SECOND cancel sends nothing, so a closing form cannot double-abort', () => {
    // `CutTransfer.cancel` is idempotent (core), and this pins that the engine does not
    // defeat that by building a second transfer or calling through after the end.
    const { session, aids } = withSpy(withField(in3270(makeSession(24, 80))));
    const run = startTransfer({ ...base, session, files: fakeFiles(), request: aReceive(), command: 'x' });
    run.cancel!();
    run.cancel!();
    expect(aids).toEqual([AID.ENTER, AckAid.ABORT]);
  });

  it('REPORTS the cancellation through onDone, so the form does not sit on "transferring"', () => {
    const { session } = withSpy(withField(in3270(makeSession(24, 80))));
    let done: { ok: boolean; error?: string } | undefined;
    const run = startTransfer({
      session, files: fakeFiles(), request: aReceive(), command: 'x',
      onProgress: () => {}, onDone: (d) => { done = d; },
    });
    run.cancel!();
    expect(done?.ok).toBe(false);
    expect(done?.error).toMatch(/canceled by user/);
  });

  it('REMOVES its screen listener when the transfer ends', () => {
    // A leaked listener per transfer is invisible except as wasted CPU, which is why
    // Session.listenerCount exists at all.
    const { session } = withSpy(withField(in3270(makeSession(24, 80))));
    const before = session.listenerCount('screen');
    const run = startTransfer({ ...base, session, files: fakeFiles(), request: aReceive(), command: 'x' });
    expect(session.listenerCount('screen')).toBe(before + 1);   // it really registered one
    run.cancel!();
    expect(session.listenerCount('screen')).toBe(before);
  });

  it('REMOVES the listener on a TIMEOUT too, not only on cancel', async () => {
    // The other exit path, and the one a long-running TUI hits without anybody watching.
    vi.useFakeTimers();
    try {
      const { session } = withSpy(withField(in3270(makeSession(24, 80))));
      const before = session.listenerCount('screen');
      startTransfer({
        session, files: fakeFiles(), request: aReceive(), command: 'x',
        onProgress: () => {}, onDone: () => {}, frameMs: 1000, totalMs: 5000,
      });
      await vi.advanceTimersByTimeAsync(1200);
      expect(session.listenerCount('screen')).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CLEARS ITS TIMERS on cancel, so a cancelled run cannot report a timeout later', async () => {
    // A timer surviving the cancel would call onDone a SECOND time, overwriting "cancelled"
    // with "timed out" on a form the operator has already closed.
    //
    // TWO GUARDS COVER THIS AND EITHER ALONE IS SUFFICIENT, measured by mutation: removing
    // `clearTimers()` leaves the `ended` flag refusing the late call, and removing `ended`
    // leaves the cleared timers never firing. So each mutation alone keeps this green and
    // only removing BOTH reddens it -- with both gone, onDone fires THREE times (cancel,
    // frame deadline, total deadline) and the last one overwrites "cancelled" with "timed
    // out". Defence in depth, like the pfAID/sendAID pair in frontend: recorded here so a
    // future reader does not delete one as redundant on the evidence of a green suite.
    vi.useFakeTimers();
    try {
      const { session } = withSpy(withField(in3270(makeSession(24, 80))));
      const results: { ok: boolean; error?: string }[] = [];
      const run = startTransfer({
        session, files: fakeFiles(), request: aReceive(), command: 'x',
        onProgress: () => {}, onDone: (d) => { results.push(d); }, frameMs: 1000, totalMs: 5000,
      });
      run.cancel!();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(results).toHaveLength(1);
      expect(results[0]?.error).toMatch(/canceled by user/);
    } finally {
      vi.useRealTimers();
    }
  });
  it('EVERY local refusal happens before the host is told, not just the unformatted one', () => {
    // The module's central rule, asserted over all four local checks at once rather than
    // trusting each test's own `aids` assertion. MEASURED WHY THIS IS NEEDED: moving
    // primeAndType after sendAID reddens only the unformatted-screen test, because that is
    // the only refusal primeAndType itself raises -- the file checks sit above it either way.
    // This pins the whole ordering so a future reshuffle cannot pass by moving one check.
    const mk = (
      build: () => { session: Session; aids: number[] },
      files: TransferFiles,
      request: TransferRequest,
    ) => {
      const { session, aids } = build();
      const run = startTransfer({ ...base, session, files, request, command: 'IND$FILE GET A' });
      return { run, aids };
    };

    // 1. wrong geometry
    let got = mk(() => withSpy(in3270(makeSession(43, 80))), fakeFiles(), aReceive());
    expect(got.run.ok).toBe(false);
    expect(got.aids).toEqual([]);
    // 2. not in 3270 mode
    got = mk(() => withSpy(makeSession(24, 80)), fakeFiles(), aReceive());
    expect(got.run.ok).toBe(false);
    expect(got.aids).toEqual([]);
    // 3. destination exists
    got = mk(() => withSpy(withField(in3270(makeSession(24, 80)))),
      fakeFiles({ '/tmp/a.bin': new Uint8Array([1]) }), aReceive('/tmp/a.bin'));
    expect(got.run.ok).toBe(false);
    expect(got.aids).toEqual([]);
    // 4. source unreadable
    got = mk(() => withSpy(withField(in3270(makeSession(24, 80)))), fakeFiles(), aSend('/tmp/x'));
    expect(got.run.ok).toBe(false);
    expect(got.aids).toEqual([]);
    // 5. unformatted screen -- the one primeAndType itself raises
    got = mk(() => withSpy(in3270(makeSession(24, 80))), fakeFiles(), aReceive());
    expect(got.run.ok).toBe(false);
    expect(got.aids).toEqual([]);
  });
});
