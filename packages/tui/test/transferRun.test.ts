import { describe, it, expect, vi } from 'vitest';
import {
  AckAid, AID, encodeAddress, O_SF, Order, resolve, Session, SnaCmd,
  TelnetCmd as T, TelnetOpt as O, TelnetSubopt as S,
  type Connection, type SessionOptions,
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

/**
 * A REAL connection, because deciding is about what arrives from a host.
 *
 * Every test above runs on an UNCONNECTED session with `is3270Mode` mocked, which is enough
 * to test refusals but cannot deliver a frame. These tests need the host to actually write:
 * a DFT transfer arrives as `WriteStructuredField` records through `handleRecord`, and the
 * whole claim under test is about WHEN that happens relative to the driver's own code.
 *
 * Lifted from `core/test/dftSession.test.ts` rather than reinvented, so the wire bytes agree
 * with the tests that pinned the plumbing.
 */
class FakeConnection implements Connection {
  sent: number[] = [];
  onData: ((b: Uint8Array) => void) | undefined;
  onClose: (() => void) | undefined;
  onError: ((e: Error) => void) | undefined;

  write(b: Uint8Array): void { this.sent.push(...b); }
  close(): void { this.onClose?.(); }

  /** Pretend the host sent these bytes. */
  host(...bytes: number[]): void { this.onData?.(Uint8Array.from(bytes)); }

  negotiate(): void {
    this.host(T.IAC, T.DO, O.TERMINAL_TYPE);
    this.host(T.IAC, T.SB, O.TERMINAL_TYPE, S.SEND, T.IAC, T.SE);
    this.host(T.IAC, T.DO, O.EOR, T.IAC, T.WILL, O.EOR);
    this.host(T.IAC, T.DO, O.BINARY, T.IAC, T.WILL, O.BINARY);
    this.sent = [];
  }
}

/**
 * A connected, negotiated session sitting at a host-painted prompt, at any geometry.
 *
 * THE HOST HAS TO PAINT THE PROMPT ITSELF, and finding that out cost real time: a freshly
 * connected session is in `X Wait` until the host writes, so `startTransfer` refuses with
 * "keyboard locked" before reaching anything this file is testing. Every test above misses
 * this because an UNCONNECTED session has never been locked -- so `withField`, which just
 * pokes a field attribute in, is not enough here.
 *
 * The unlock is the WCC's keyboard-restore bit (0xc3), not the field: measured, `EraseWrite`
 * with that WCC takes the OIA from "X Wait" to "4 A". Which is exactly the sequence a real
 * host sends to put an operator at a command prompt, so the fixture is not a contrivance.
 */
async function connected(
  rows = 24, cols = 80, extra: Partial<SessionOptions> = {},
): Promise<{ session: Session; conn: FakeConnection }> {
  const conn = new FakeConnection();
  const session = new Session({ connect: () => conn, rows, cols, ...extra });
  await session.connect('localhost', 3270);
  conn.negotiate();
  expect(session.is3270Mode()).toBe(true);     // REAL, not mocked: the host negotiated it

  // EraseWrite, WCC 0xc3 (restore keyboard + reset MDT), then one unprotected field at 0 --
  // a command prompt. `resize` is not called, so a 43-row session stays at its DEFAULT 24x80
  // unless EWA switches it; `rows`/`cols` above are what size the buffer, per this file's
  // module comment.
  const [hi, lo] = encodeAddress(0, session.screen.size);
  conn.host(SnaCmd.EW, 0xc3, Order.SBA, hi!, lo!, Order.SF, 0x00, T.IAC, T.EOR);
  expect(session.oia.isInhibited()).toBe(false);   // the prompt really did unlock it
  expect(session.screen.isFormatted()).toBe(true);
  return { session, conn };
}

/** `WriteStructuredField` carrying one DFT frame: `L L SFID payload`, then IAC EOR. */
function wsfBytes(payload: number[]): number[] {
  const len = payload.length + 3;
  return [0xf3, (len >> 8) & 0xff, len & 0xff, 0xd0, ...payload, 0xff, 0xef];
}

/** A DFT `Open` payload. The name sits at payload offset 25 (`dftFrames.ts`). */
function openPayload(name = 'FT:DATA'): number[] {
  const p = new Array<number>(0x23 - 3).fill(0x00);
  p[0] = 0x00;
  p[1] = 0x12;
  const padded = name.padEnd(7, ' ');
  for (let i = 0; i < 7; i++) p[25 + i] = padded.charCodeAt(i);
  return p;
}

/** A DFT `Data Insert` carrying these bytes. */
function dataInsert(bytes: number[]): number[] {
  return [
    0x47, 0x04, 0xc0, 0x80, 0x61,
    ((bytes.length + 5) >> 8) & 0xff, (bytes.length + 5) & 0xff, ...bytes,
  ];
}

/**
 * Every record of a complete DFT download, in order: Open, data, Close, then the
 * `FT:MSG` transfer carrying `TRANS03` that reports success.
 *
 * Returned as a list of records rather than run directly, so a caller can choose WHEN to
 * deliver them -- which is the difference between two of the tests below.
 */
function wholeDftDownload(payload = [0x41, 0x42, 0x43]): number[][] {
  return [
    wsfBytes(openPayload()),
    wsfBytes(dataInsert(payload)),
    wsfBytes([0x41, 0x12]),                    // Close
    wsfBytes(openPayload('FT:MSG')),
    wsfBytes(dataInsert([...'TRANS03'].map((c) => c.charCodeAt(0)))),
  ];
}

/**
 * 0x7c is what a real TK5 host plants at `O_SF`: protected (0x20) and numeric (0x10), i.e.
 * `FA_IS_SKIP`. Taken from `core/test/ft/detect.test.ts` rather than composed from
 * `FA.PROTECT | FA.NUMERIC`, so this file agrees with the fixture and with the
 * masks-never-equality reasoning in `isCutFrame`.
 */
const CUT_FRAME_ATTR = 0x7c;

/**
 * Make the HOST paint, over real wire bytes, because that is the only honest way to fire a
 * `screen` event.
 *
 * `Session.emit` is private and there is no test seam, which is correct -- a test-only
 * emitter would let these tests pass against a driver that never sees a real host write.
 * A `Write` with an SBA is the smallest thing that reaches `emit('screen')`.
 *
 * `atSF` plants the auto-skip attribute at `O_SF` and so paints a CUT FRAME; without it the
 * host has painted something that is not one, which is the other case the timeout
 * distinguishes.
 */
function hostPaints(conn: FakeConnection, session: Session, atSF = false): void {
  const addr = atSF ? O_SF : 0;
  const [hi, lo] = encodeAddress(addr, session.screen.size);
  const body = atSF
    ? [Order.SBA, hi!, lo!, Order.SF, CUT_FRAME_ATTR]
    : [Order.SBA, hi!, lo!, 0xc8];       // one character: a host painting anything at all
  conn.host(SnaCmd.W, 0x00, ...body, T.IAC, T.EOR);
}

describe('protocol selection: deciding', () => {
  it('a CUT frame commits to CUT and releases the DFT registration', async () => {
    const { session, conn } = await connected();
    const run = startTransfer({
      ...base, session, files: fakeFiles(), request: aReceive(), command: 'IND$FILE GET A.BIN',
    });
    expect(run.ok).toBe(true);
    expect(session.dftTransfer).toBeDefined();

    // The host paints a CUT frame: an auto-skip attribute at O_SF, which is what
    // `looksLikeCutFrame` tests for. Over real wire bytes, so the screen event is the real
    // one rather than a test-only emitter.
    hostPaints(conn, session, true);

    // RELEASED, or `answerRead` would replay the DFT engine's retained frame at a host now
    // running a CUT transfer.
    expect(session.dftTransfer).toBeUndefined();
    run.cancel!();
  });

  it('a DFT host completes THROUGH transferEnd, with no CUT frame ever painted', async () => {
    // THE TEST THAT CATCHES THE SPIN-TO-TIMEOUT BUG, and the plan was WRONG about the
    // mechanism in a way worth recording, because the wrong version would have failed here
    // and looked like a product bug.
    //
    // The plan says "a DFT transfer produces ZERO screen events, so assert the count is
    // zero". IT IS NOT ZERO: `emit('screen')` fires once per RECORD handled, and a DFT frame
    // arrives as a WriteStructuredField record (`session.ts:897` -- unconditional, after the
    // `transferData` dispatch at `:880`). Measured: five records, five screen events, and the
    // screen BUFFER byte-identical throughout.
    //
    // Which makes the conclusion STRONGER, not weaker. Those events are indistinguishable to
    // `onScreen` from a host painting a menu -- `looksLikeCutFrame` is false for all of them,
    // since nothing was written at O_SF -- so a driver that treated `screen` as its DFT
    // progress signal would see five non-frames and spin to its deadline on a healthy
    // transfer. So what has to be asserted is that completion came through `transferEnd` and
    // that CUT never committed, which is what the `dftTransfer`/`committed` observables below
    // say. The screen COUNT is asserted as non-zero to pin the corrected mechanism.
    const { session, conn } = await connected();
    let screens = 0;
    session.on('screen', () => { screens++; });
    let settle!: (r: { ok: boolean; error?: string; bytes?: number }) => void;
    const done = new Promise<{ ok: boolean; error?: string; bytes?: number }>((r) => {
      settle = r;
    });
    const run = startTransfer({
      session, files: fakeFiles(), request: aReceive('/tmp/got.bin'),
      command: 'IND$FILE GET A.BIN', onProgress: () => {}, onDone: settle,
    });
    expect(run.ok).toBe(true);

    // SNAPSHOT AFTER PRIMING, not before: `startTransfer` types the command and moves the
    // cursor, which is a local change and not the host painting. Taking it earlier compared
    // the typing against the transfer and reported a cursor move as host output.
    const primed = JSON.stringify(session.screen.snapshot());
    const screensAfterPriming = screens;

    for (const record of wholeDftDownload()) conn.host(...record);

    await expect(done).resolves.toMatchObject({ ok: true, bytes: 3 });
    // THE SCREEN EVENTS HAPPENED and painted NOTHING: the corrected mechanism, both halves.
    expect(screens).toBeGreaterThan(screensAfterPriming);
    expect(JSON.stringify(session.screen.snapshot())).toBe(primed);
  });

  it('WRITES THE RECEIVED FILE, reading the bytes off the RESULT', async () => {
    // `DftTransfer` HAS NO `data` ACCESSOR -- the plan's snippet reads `dft.data`, which does
    // not exist (`dft.ts:175-183` is the whole surface). A received payload comes back on
    // `result.data`, the success arm of the `TransferResult` union. Without this test the
    // difference is invisible: `undefined` coalesces to an empty array and the transfer
    // still reports ok, so the operator gets a SUCCESS and a ZERO-BYTE FILE.
    const { session, conn } = await connected();
    const files = fakeFiles();
    let settle!: (r: { ok: boolean; error?: string; bytes?: number }) => void;
    const done = new Promise<{ ok: boolean }>((r) => { settle = r as typeof settle; });

    startTransfer({
      session, files, request: aReceive('/tmp/got.bin'),
      command: 'IND$FILE GET A.BIN', onProgress: () => {}, onDone: settle,
    });
    for (const record of wholeDftDownload([0x41, 0x42, 0x43])) conn.host(...record);

    await expect(done).resolves.toMatchObject({ ok: true });
    expect([...(files.files.get('/tmp/got.bin') ?? [])]).toEqual([0x41, 0x42, 0x43]);
  });

  it('notices a DFT transfer that finished BEFORE the first wait', async () => {
    // CHECK STATE FIRST, THEN WAIT. A whole DFT transfer can begin and finish inside record
    // handling -- here, inside `sendAID`'s own call stack -- and a driver that only
    // subscribes afterwards has already missed it. The symptom is a hang indistinguishable
    // from the spin-to-timeout bug above.
    //
    // DRIVEN FROM INSIDE `sendAID`, which is what makes it that case and not a re-run of the
    // test above: the entire transfer is delivered before `startTransfer` has returned, so
    // no listener registered after the send could have seen any of it.
    const { session, conn } = await connected();
    const files = fakeFiles();
    const results: { ok: boolean; error?: string }[] = [];

    const realSendAID = session.sendAID.bind(session);
    vi.spyOn(session, 'sendAID').mockImplementation((aid: number) => {
      realSendAID(aid);
      for (const record of wholeDftDownload()) conn.host(...record);
    });

    const run = startTransfer({
      session, files, request: aReceive('/tmp/got.bin'), command: 'IND$FILE GET A.BIN',
      onProgress: () => {}, onDone: (d) => { results.push(d); },
    });

    // SYNCHRONOUS, deliberately: no `await` between the send and this assertion, so a driver
    // that needed a turn of the event loop to notice would fail here.
    expect(results).toEqual([{ ok: true, bytes: 3 }]);
    expect(run.ok).toBe(true);
    expect([...(files.files.get('/tmp/got.bin') ?? [])]).toEqual([0x41, 0x42, 0x43]);
  });

  it('SUBSCRIBES TO transferEnd BEFORE priming, which is what the dead `dft.complete` replaced', () => {
    // THE PLAN ASKED FOR `if (dft.complete) { onTransferEnd(); return }` AFTER `sendAID`, as a
    // "check state before waiting" guard. It was DELETED as dead code, and this test is what
    // stands in its place -- so read the two together.
    //
    // Why it was dead: nothing between `startDftTransfer` and the listener registration can
    // reach the socket (the intervening lines are closure definitions and `let`s), so
    // `dft.complete` is unfalsifiably false where the plan put it. Its own mutation check could
    // not be made to fail -- removing the block left every test green -- and the spec's rule is
    // explicit: "If nothing does, the call is decoration and should be deleted rather than
    // kept."
    //
    // The REAL invariant is the ORDER, which this asserts directly: `transferEnd` must be
    // subscribed before `sendAID` can deliver anything, because a whole DFT transfer can finish
    // inside that call. The test above drives that case end to end; this one pins the mechanism
    // that makes it work, so a future reshuffle cannot pass by reversing two lines.
    const conn = new FakeConnection();
    const session = new Session({ connect: () => conn, rows: 24, cols: 80 });
    const order: string[] = [];
    const realOn = session.on.bind(session);
    vi.spyOn(session, 'on').mockImplementation((ev, fn) => {
      order.push(`on:${ev}`);
      realOn(ev, fn);
    });
    vi.spyOn(session, 'sendAID').mockImplementation(() => { order.push('sendAID'); });
    vi.spyOn(session, 'is3270Mode').mockReturnValue(true);
    session.screen.setFieldAttribute(0, 0x00);

    startTransfer({
      ...base, session, files: fakeFiles(), request: aReceive(), command: 'IND$FILE GET A.BIN',
    });

    expect(order.indexOf('on:transferEnd')).toBeGreaterThanOrEqual(0);   // it really subscribed
    expect(order.indexOf('on:transferEnd')).toBeLessThan(order.indexOf('sendAID'));
  });

  it('REMOVES BOTH listeners when a DFT transfer ends', async () => {
    // Two listeners now, not one. The `transferEnd` one is the new leak, and it is invisible
    // except as wasted CPU -- which is why `Session.listenerCount` exists at all.
    const { session, conn } = await connected();
    const screensBefore = session.listenerCount('screen');
    const endsBefore = session.listenerCount('transferEnd');

    startTransfer({
      ...base, session, files: fakeFiles(), request: aReceive('/tmp/got.bin'),
      command: 'IND$FILE GET A.BIN',
    });
    expect(session.listenerCount('transferEnd')).toBe(endsBefore + 1);

    for (const record of wholeDftDownload()) conn.host(...record);

    expect(session.listenerCount('screen')).toBe(screensBefore);
    expect(session.listenerCount('transferEnd')).toBe(endsBefore);
  });

  it('CANCELLING A DFT TRANSFER MID-FLIGHT ABORTS IT, keeping the registration alive', async () => {
    // ABORT, NOT ABANDON -- the rule this module states for CUT, applied to DFT, and the two
    // need OPPOSITE handling of the registration. `DftTransfer.cancel` DEFERS: it sets a flag
    // checked on the next inbound frame (`dft.ts:205-208`, matching x3270's `ft_dft.c:225`,
    // `:576`), so the engine must STILL BE REGISTERED for that frame to reach it. Calling
    // `session.cancelDftTransfer()` here -- correct for a host that never spoke -- would
    // discard the engine and leave the host's program waiting for a frame that never comes.
    //
    // MEASURED AS NECESSARY: with this branch removed the whole suite stayed green, which is
    // why the test exists rather than the reasoning alone. The observable is the host's own
    // next frame drawing a USER_CANCEL reply, i.e. the abort really reaching the wire.
    const { session, conn } = await connected();
    const results: { ok: boolean; error?: string }[] = [];
    const run = startTransfer({
      session, files: fakeFiles(), request: aReceive('/tmp/got.bin'),
      command: 'IND$FILE GET A.BIN', onProgress: () => {}, onDone: (d) => { results.push(d); },
    });
    expect(run.ok).toBe(true);

    // The transfer is genuinely under way: Open, then one data frame.
    conn.host(...wsfBytes(openPayload()));
    conn.host(...wsfBytes(dataInsert([0x41, 0x42])));
    expect(session.dftTransfer?.transferred).toBe(2);

    run.cancel!();

    // STILL REGISTERED, which is the whole point -- the abort has been REQUESTED, not sent.
    expect(session.dftTransfer).toBeDefined();
    expect(results).toHaveLength(1);
    expect(results[0]?.error).toMatch(/canceled by user/);

    // And the next inbound frame is what carries it: the engine refuses the data and replies,
    // which is the host being TOLD rather than left waiting.
    conn.sent = [];
    conn.host(...wsfBytes(dataInsert([0x43])));
    expect(conn.sent.length).toBeGreaterThan(0);
    expect(session.dftTransfer).toBeUndefined();     // and the transfer is over
  });

  it('a DFT transfer at 43x80 works, which is the whole point of the branch', async () => {
    // THE PAYOFF. Before this design a 43x80 session could not transfer a file at all: the
    // geometry gate refused before a byte reached the host. DFT has no 24x80 requirement --
    // it is structured fields, not screen scraping -- so this is the case the deletion
    // BOUGHT, and it would be silently lost if a future change reinstated the gate.
    const { session, conn } = await connected(43, 80);
    expect(session.screen.size).toBe(3440);
    const files = fakeFiles();
    let settle!: (r: { ok: boolean }) => void;
    const done = new Promise<{ ok: boolean }>((r) => { settle = r; });

    startTransfer({
      session, files, request: aReceive('/tmp/got.bin'), command: 'IND$FILE GET A.BIN',
      onProgress: () => {}, onDone: settle as never,
    });
    for (const record of wholeDftDownload()) conn.host(...record);

    await expect(done).resolves.toMatchObject({ ok: true });
    expect([...(files.files.get('/tmp/got.bin') ?? [])]).toEqual([0x41, 0x42, 0x43]);
  });
});

describe('the timeout message reports what was OBSERVED', () => {
  it('names -ddm on when nothing arrived and DDM was never advertised', async () => {
    // EARNS ITS PLACE: forgetting `-ddm on` will be the commonest failure once DFT works,
    // because a host that speaks only DFT cannot CHOOSE DFT unless we advertised QCODE 0x95.
    // Without this the operator sees a bare timeout and no reason to suspect a flag.
    vi.useFakeTimers();
    try {
      const { session } = await connected();
      expect(session.ddmAdvertised).toBe(false);
      let done: { ok: boolean; error?: string } | undefined;
      startTransfer({
        session, files: fakeFiles(), request: aReceive(), command: 'x',
        onProgress: () => {}, onDone: (d) => { done = d; }, frameMs: 1000, totalMs: 5000,
      });
      await vi.advanceTimersByTimeAsync(1200);
      expect(done?.error).toMatch(/-ddm on/);
      expect(done?.error).toMatch(/Attn or Clear/);   // the recovery still leads
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT name -ddm on when DDM WAS advertised', async () => {
    // The other half, and the one that stops the clause becoming noise printed on every
    // timeout. Without it the message would advise a flag the operator already set.
    vi.useFakeTimers();
    try {
      const { session } = await connected(24, 80, { ddm: true });
      expect(session.ddmAdvertised).toBe(true);
      let done: { ok: boolean; error?: string } | undefined;
      startTransfer({
        session, files: fakeFiles(), request: aReceive(), command: 'x',
        onProgress: () => {}, onDone: (d) => { done = d; }, frameMs: 1000, totalMs: 5000,
      });
      await vi.advanceTimersByTimeAsync(1200);
      expect(done?.error).not.toMatch(/-ddm on/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the GEOMETRY when screens arrived and none was a CUT frame', async () => {
    // THE FALLBACK ROW, and it is a fallback on purpose. Measured on VM/370: MECAFF answers
    // `IND$FILE requires a MECAFF connected 3270 terminal` and CMS recovers in about a
    // second, so the HOST'S OWN TEXT usually arrives and is better than ours. This row is
    // for a CUT-only host at 43x80 that goes quiet instead.
    vi.useFakeTimers();
    try {
      const { session, conn } = await connected(43, 80);
      let done: { ok: boolean; error?: string } | undefined;
      startTransfer({
        session, files: fakeFiles(), request: aReceive(), command: 'x',
        onProgress: () => {}, onDone: (d) => { done = d; }, frameMs: 1000, totalMs: 5000,
      });
      // The host paints SOMETHING -- a refusal, a menu -- but never a CUT frame.
      hostPaints(conn, session);
      await vi.advanceTimersByTimeAsync(1200);
      expect(done?.error).toMatch(/43x80/);
      expect(done?.error).not.toMatch(/-ddm on/);   // screens DID arrive, so not that row
    } finally {
      vi.useRealTimers();
    }
  });

  it('says neither thing when screens arrived at 24x80, because both would mislead', async () => {
    // A 24x80 host painting non-frames is a host that ignored the command -- wrong panel,
    // IND$FILE not installed. Blaming the geometry would be false and blaming -ddm would be
    // irrelevant, so the message stays bare rather than guessing.
    vi.useFakeTimers();
    try {
      const { session, conn } = await connected(24, 80);
      let done: { ok: boolean; error?: string } | undefined;
      startTransfer({
        session, files: fakeFiles(), request: aReceive(), command: 'x',
        onProgress: () => {}, onDone: (d) => { done = d; }, frameMs: 1000, totalMs: 5000,
      });
      hostPaints(conn, session);
      await vi.advanceTimersByTimeAsync(1200);
      expect(done?.error).not.toMatch(/-ddm on/);
      expect(done?.error).not.toMatch(/24x80/);
      expect(done?.error).toMatch(/Attn or Clear/);
    } finally {
      vi.useRealTimers();
    }
  });
});
