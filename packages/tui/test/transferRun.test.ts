import { describe, it, expect, vi } from 'vitest';
import {
  AckAid, AID, resolve, Session, type Connection,
} from '@tn3270/core';
import {
  newTransferForm, startTransfer, type TransferFiles, type TransferRequest,
} from '@tn3270/frontend';
import { transferLines } from '../src/transferOverlay.js';

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
  it('refuses when not in 3270 mode', () => {
    // No `in3270` here: an unconnected session already reports false, which is the state a
    // TUI is in before it connects.
    const { session } = withSpy(makeSession(24, 80));
    expect(session.is3270Mode()).toBe(false);
    const r = startTransfer({ ...base, session, files: fakeFiles(), request: aReceive(), command: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not in 3270 mode/);
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

  it('THE TIMEOUT SURVIVES THE 54-COLUMN STATUS LINE with its recovery intact', async () => {
    // THIS IS WHY THIS TEST FILE LIVES IN `tui/test` AND NOT BESIDE ITS SUBJECT: it asserts
    // on the RENDERED line, through `tui`'s own `transferLines`, and `frontend` cannot import
    // `tui`. It replaces the geometry-refusal version of this test, which this task deleted
    // along with the message it guarded -- the LESSON is not about geometry, it is that a
    // 54-column line truncates, so the ACTION must come first. Task 6 adds clauses to this
    // very message, which is exactly when the assertion is needed.
    //
    // Measured history, per transferOverlay.ts: the CLI's word order put "(press Attn or
    // Clear)" at character 113 of a 54-column line, so the one actionable phrase -- on the
    // one failure where the host may still be mid-transfer -- was the part cut off. Every
    // other test here reads `done.error` directly, which is precisely why none of them saw it.
    vi.useFakeTimers();
    try {
      const { session } = withSpy(withField(in3270(makeSession(24, 80))));
      let done: { ok: boolean; error?: string } | undefined;
      startTransfer({
        session, files: fakeFiles(), request: aReceive(), command: 'x',
        onProgress: () => {}, onDone: (d) => { done = d; }, frameMs: 1000, totalMs: 5000,
      });
      await vi.advanceTimersByTimeAsync(1200);

      const lines = transferLines({ ...newTransferForm(), error: done?.error }, 'idle', undefined);
      const status = lines[lines.length - 1] ?? '';
      expect(status.trimEnd().endsWith('>')).toBe(true);   // it IS truncated; that is fine
      expect(status).toMatch(/Attn or Clear/);             // but the RECOVERY is still there
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

    // GEOMETRY IS NO LONGER ON THIS LIST, and removing it was not a deletion of one line.
    // The case that used to be here was `in3270(makeSession(43, 80))` with no `withField`,
    // which STILL refuses and STILL sends nothing -- on the UNFORMATTED screen, one check
    // further down. So it would have gone on passing while testing something else entirely,
    // the vacuous pass this branch keeps finding. Deleted rather than left green.

    // 1. not in 3270 mode
    let got = mk(() => withSpy(makeSession(24, 80)), fakeFiles(), aReceive());
    expect(got.run.ok).toBe(false);
    expect(got.aids).toEqual([]);
    // 2. destination exists
    got = mk(() => withSpy(withField(in3270(makeSession(24, 80)))),
      fakeFiles({ '/tmp/a.bin': new Uint8Array([1]) }), aReceive('/tmp/a.bin'));
    expect(got.run.ok).toBe(false);
    expect(got.aids).toEqual([]);
    // 3. source unreadable
    got = mk(() => withSpy(withField(in3270(makeSession(24, 80)))), fakeFiles(), aSend('/tmp/x'));
    expect(got.run.ok).toBe(false);
    expect(got.aids).toEqual([]);
    // 4. unformatted screen -- the one primeAndType itself raises
    got = mk(() => withSpy(in3270(makeSession(24, 80))), fakeFiles(), aReceive());
    expect(got.run.ok).toBe(false);
    expect(got.aids).toEqual([]);
  });
});

/**
 * THE ONE DELETION THIS DESIGN MAKES, and the tests that pin what replaced it.
 *
 * Under host-chooses-the-protocol the client cannot know CUT was chosen until the host has
 * answered -- x3270's `ft_running` merely REPORTS which protocol arrived (`ft.c:556`) and
 * has no selection logic at all -- so a 24x80 demand made before the host is asked is a
 * demand made on no evidence. The accepted cost, raised and measured: a CUT-only host at
 * 43x80 is now primed before we find out.
 */
describe('protocol selection: the geometry gate is gone', () => {
  it('does not refuse a 43x80 session before the host is asked', () => {
    const { session } = withSpy(withField(in3270(makeSession(43, 80))));
    // ASSERTED FIRST, for the reason the module comment gives: `alternateRows: 43` would
    // give a 1920-cell screen and this test would then pass without ever being at 43x80.
    expect(session.screen.size).toBe(3440);
    const run = startTransfer({
      ...base, session, files: fakeFiles(), request: aReceive(), command: 'IND$FILE GET A.BIN',
    });
    expect(run.ok).toBe(true);
    run.cancel!();      // do not leave a listener and two timers behind
  });

  it('still refuses when not in 3270 mode, AT 43x80 TOO', () => {
    // The other local checks are unchanged and must stay reachable. The geometry gate used
    // to shadow this one at 43x80 -- there was a test asserting exactly that order -- so
    // this is the case whose ANSWER CHANGED, not merely one that still passes.
    const { session, aids } = withSpy(withField(makeSession(43, 80)));
    expect(session.is3270Mode()).toBe(false);
    const run = startTransfer({
      ...base, session, files: fakeFiles(), request: aReceive(), command: 'x',
    });
    expect(run.ok).toBe(false);
    expect(run.error).toMatch(/not in 3270 mode/);
    expect(run.error).not.toMatch(/24x80/);     // the old message must not still be first
    expect(aids).toEqual([]);
  });

  it('registers the DFT transfer BEFORE the host is primed, not merely by the time we return', () => {
    // A fast host's first 0xd0 arrives from inside `handleRecord`, before any driver code
    // runs again, and `handleTransferData` needs a registered transfer AT THAT MOMENT.
    //
    // SO THE ASSERTION IS MADE FROM INSIDE `sendAID`, not after `startTransfer` returns.
    // Checking afterwards cannot tell "registered before priming" from "registered after",
    // which is the entire claim -- and the second one loses the first frame of a fast
    // transfer to a race. Measured: with `startDftTransfer` moved below `sendAID(ENTER)`
    // the after-the-fact check stays green and this one reddens.
    const session = withField(in3270(makeSession(24, 80)));
    let registeredWhenPrimed: boolean | undefined;
    vi.spyOn(session, 'sendAID').mockImplementation(() => {
      registeredWhenPrimed ??= session.dftTransfer !== undefined;
    });

    const run = startTransfer({
      ...base, session, files: fakeFiles(), request: aReceive(), command: 'IND$FILE GET A.BIN',
    });

    expect(run.ok).toBe(true);
    expect(registeredWhenPrimed).toBe(true);
    run.cancel!();
  });

  it('CANCELLING AT 43x80 REPORTS rather than throwing CutFrameError at the operator', () => {
    // A DEFECT THIS TASK INTRODUCED, found by running the deletion and not predicted by the
    // plan: the geometry gate was load-bearing for `cancel` as well as for stepping. With it
    // gone, `CutTransfer.cancel` is reachable at 43x80, and it writes the response area
    // through `writeResponse` -> `requireCutGeometry`, which THROWS (`frames.ts:314`). The
    // throw escaped uncaught into the TUI's form-close path -- `Esc` on the form -- which is
    // the one place an operator cannot avoid.
    //
    // The observable is deliberately the ABSENCE of a throw plus a reported outcome, because
    // "it did not crash" alone would pass on a cancel that silently did nothing.
    const { session, aids } = withSpy(withField(in3270(makeSession(43, 80))));
    const results: { ok: boolean; error?: string }[] = [];
    const run = startTransfer({
      session, files: fakeFiles(), request: aReceive(), command: 'IND$FILE GET A.BIN',
      onProgress: () => {}, onDone: (d) => { results.push(d); },
    });
    expect(run.ok).toBe(true);

    expect(() => { run.cancel!(); }).not.toThrow();

    expect(results).toHaveLength(1);
    expect(results[0]?.error).toMatch(/canceled by user/);
    // NO PF2. There is no CUT frame layout to write into at this geometry and the host never
    // said it was running CUT, so synthesising an abort would put bytes on the wire that no
    // captured session contains -- the rule this module already states for timeouts.
    expect(aids).toEqual([AID.ENTER]);
  });

  it('a cancelled run RELEASES the DFT registration, so no retained frame is replayed', () => {
    // The registration happens before priming, so every exit path owns releasing it.
    // `answerRead` replays a DFT engine's retained frame, which at a host that has moved on
    // is unsolicited traffic. `handleClose` clears `dft` too, but a form closed on a LIVE
    // session never reaches it -- so this path must do it itself.
    const { session } = withSpy(withField(in3270(makeSession(24, 80))));
    const run = startTransfer({
      ...base, session, files: fakeFiles(), request: aReceive(), command: 'IND$FILE GET A.BIN',
    });
    expect(session.dftTransfer).toBeDefined();
    run.cancel!();
    expect(session.dftTransfer).toBeUndefined();
  });

  it('builds the DFT engine for the SAME direction, over the same source bytes', () => {
    // Both engines are built over one source buffer, which is what makes this one object
    // rather than a second copy. A send is the direction that can get this wrong: a
    // `DftTransfer` built as `receive` would THROW on the data it was handed
    // (`dft.ts:163-168`), and a `send` built with no data throws too.
    const session = withField(in3270(makeSession(24, 80)));
    vi.spyOn(session, 'sendAID').mockImplementation(() => {});
    const files = fakeFiles({ '/tmp/a.bin': new Uint8Array([1, 2, 3]) });
    const run = startTransfer({
      ...base, session, files, request: aSend('/tmp/a.bin'), command: 'IND$FILE PUT A.BIN',
    });
    expect(run.ok).toBe(true);
    expect(session.dftTransfer?.direction).toBe('send');
    run.cancel!();
  });
});
