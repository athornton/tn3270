import { describe, it, expect, vi } from 'vitest';
import { Session, AID, type Connection } from '@tn3270/core';
import { applyAction } from '../src/actions.js';
import type { Action } from '../src/keymap.js';
import { actionKinds, ACTION_KIND_FLOOR, ACTION_KIND_CANARIES } from './helpers/actionKinds.js';

class FakeConnection implements Connection {
  sent: number[] = [];
  onData: ((b: Uint8Array) => void) | undefined;
  onClose: (() => void) | undefined;
  onError: ((e: Error) => void) | undefined;
  write(b: Uint8Array): void { this.sent.push(...b); }
  close(): void { this.onClose?.(); }
}

function newSession() {
  const conn = new FakeConnection();
  const session = new Session({ connect: () => conn });
  return { session, conn };
}

describe('applyAction', () => {
  it('sends the Enter AID', async () => {
    const { session, conn } = newSession();
    await session.connect('h', 23);
    conn.sent = [];
    applyAction(session, { kind: 'enter' });
    expect(conn.sent).toContain(AID.ENTER);
  });

  it('sends PF3 as its own AID, not PF1 plus an offset', async () => {
    // The `n - 1` index is the kind of thing that survives a move looking correct and
    // being wrong by one, so the AID is asserted by value.
    //
    // MUST CONNECT FIRST. Written without the connect, this asserted `undefined` and
    // failed -- a disconnected session sends nothing and `applyAction` swallows the
    // refusal, which is correct behaviour and makes any wire assertion vacuous.
    const { session, conn } = newSession();
    await session.connect('h', 23);
    conn.sent = [];
    applyAction(session, { kind: 'pf', n: 3 });
    expect(conn.sent[0]).toBe(0xf3);        // PF3
  });

  it('puts NOTHING on the wire for an out-of-range pf or pa number', async () => {
    // THE DEFECT THIS PINS, measured before the fix: `PF_AIDS[action.n - 1]!` on an out-of-range
    // `n` is `undefined`, the `!` hides it, and `buildReadModified`'s `Uint8Array.from([undefined])`
    // SILENTLY COERCES IT TO 0 -- so `{kind:'pf', n:-1}` transmitted AID 0x00 to a live mainframe
    // and locked the local keyboard, with `applyAction`'s catch-all swallowing any complaint.
    //
    // The other front ends were safe only because their `n` comes from a trusted keymap table. The
    // web gateway is the first where a REMOTE party supplies it, and bounding it there closed the
    // live hole -- but at the boundary, not structurally.
    //
    // THIS IS A DEFENCE-IN-DEPTH TEST, and the mutation matrix is worth stating because it is not
    // what it first looks like. TWO independent guards now stand behind it: `pfAID`/`paAID` refuse
    // the number, and `Session.sendAID` refuses the resulting byte. MEASURED, all four combinations:
    //
    //   both guards            -> nothing sent (this test passes)
    //   accessor removed only  -> nothing sent; `sendAID` refuses `undefined`
    //   backstop removed only  -> nothing sent; `pfAID` throws first
    //   BOTH removed           -> [0x00, 0x40, 0x40, 0xff, 0xef] on the wire, the original defect
    //
    // So this test alone does NOT pin either guard -- it pins that at least one survives, which is
    // the property that actually matters here. Each guard has its own falsifying test:
    // `constants.test.ts` for the accessors and `session.test.ts` for `sendAID`.
    for (const action of [
      { kind: 'pf', n: -1 }, { kind: 'pf', n: 0 }, { kind: 'pf', n: 25 }, { kind: 'pf', n: 1e9 },
      { kind: 'pf', n: 1.5 }, { kind: 'pf', n: Number.NaN },
      { kind: 'pa', n: 0 }, { kind: 'pa', n: 4 }, { kind: 'pa', n: -1 },
    ] as const) {
      const { session, conn } = newSession();
      await session.connect('h', 23);
      conn.sent = [];
      applyAction(session, action);
      expect(conn.sent, `for ${JSON.stringify(action)}`).toEqual([]);
    }
  });

  it('sends PA2 as its own AID too', async () => {
    // The same off-by-one risk on the other table, which has only three entries.
    const { session, conn } = newSession();
    await session.connect('h', 23);
    conn.sent = [];
    applyAction(session, { kind: 'pa', n: 2 });
    expect(conn.sent[0]).toBe(0x6e);        // PA2
  });

  it('types into the screen through the keyboard', () => {
    const { session } = newSession();
    applyAction(session, { kind: 'type', text: 'HI' });
    // No assertion about the wire: typing is local until an AID is sent. The keyboard
    // owns whether it was allowed, and it says so in the OIA.
    expect(session.oia.toText()).toBeTypeOf('string');
  });

  it('SWALLOWS a rejected action rather than throwing', () => {
    // A rejected action -- not connected, program check -- is normal operation, not a
    // crash. This is the behaviour the TUI relied on, and moving the dispatch must not
    // turn it into an exception that reaches the run loop.
    const { session } = newSession();
    expect(() => applyAction(session, { kind: 'enter' })).not.toThrow();
  });

  it('REFUSES to handle quit, which is the front end s own business', () => {
    // Teardown differs per front end: the TUI restores raw mode, the GUI closes a
    // window. A shared dispatch that silently ignored `quit` would make a front end
    // that forgot to check it simply unquittable, so it throws instead.
    //
    // THE PATTERN MATCHES THE DELIBERATE MESSAGE, not just the word. `/quit/i` -- as this
    // read until now -- passes on any incidental error that happens to name the action,
    // including the `TypeError: ...quit is not a function` Node raises for a typo'd method
    // call. MEASURED on the `toggleKeypad` twin below, which had the identical weakness.
    const { session } = newSession();
    expect(() => applyAction(session, { kind: 'quit' })).toThrow(/does not handle quit/);
  });
});

describe('applyAction: the newly-bound actions', () => {
  it('sends Attn as a Telnet BREAK, not an AID', () => {
    // Session.sendAttn() -> telnet BREAK, RFC 1576 section 8. Attn is NOT an AID, so this
    // must not go anywhere near sendAID.
    const { session } = newSession();
    const attn = vi.spyOn(session, 'sendAttn');
    const aid = vi.spyOn(session, 'sendAID');
    applyAction(session, { kind: 'attn' });
    expect(attn).toHaveBeenCalledOnce();
    expect(aid).not.toHaveBeenCalled();
  });

  it('toggles insert mode both ways', () => {
    const { session } = newSession();
    expect(session.keyboard.insertMode).toBe(false);
    applyAction(session, { kind: 'toggleInsert' });
    expect(session.keyboard.insertMode).toBe(true);
    applyAction(session, { kind: 'toggleInsert' });
    expect(session.keyboard.insertMode).toBe(false);
  });

  it('keeps the OIA in step with insert mode, since it reads the same flag', () => {
    const { session } = newSession();
    applyAction(session, { kind: 'toggleInsert' });
    expect(session.oia.insertMode).toBe(true);
  });
});

describe('applyAction: Enter and Clear reconnect while disconnected', () => {
  // VM/370 prints "Press Enter or Clear to continue" as it drops the connection, and both keys used
  // to do NOTHING: `sendAID` throws 'not connected' and `applyAction` swallows it. BOTH DIRECTIONS
  // ARE ASSERTED, here and in the dispatch table, because either one alone is satisfied by a
  // one-line mutation: a body that always reconnects passes the tests below, and a body that never
  // does passes the table's `enter`/`clear` rows.

  it('reconnects to the SAME host and port, and sends NOTHING, for both keys', async () => {
    for (const kind of ['enter', 'clear'] as const) {
      const dialled: [string, number][] = [];
      const conn = new FakeConnection();
      const session = new Session({
        connect: (h, p) => { dialled.push([h, p]); return conn; },
      });
      await session.connect('vm.example', 3270);
      conn.sent = [];
      // The host hangs up, exactly as a LOGOFF does.
      conn.close();
      expect(session.isConnected(), kind).toBe(false);

      const aid = vi.spyOn(session, 'sendAID');
      applyAction(session, { kind });
      // `reconnect()` is async and `applyAction` cannot await it: one microtask turn is what the
      // fake connection needs, and awaiting here is also what would surface an unhandled rejection.
      await Promise.resolve();
      await Promise.resolve();

      expect(aid, `${kind} put an AID on the wire instead of reconnecting`).not.toHaveBeenCalled();
      expect(conn.sent, `${kind} sent bytes to a session it had just reopened`).toEqual([]);
      // THE PORT IS THE ASSERTION, not just the host: replaying 23 -- the default every host spec
      // falls back to -- is the transposition this catches, and it would silently dial the WRONG
      // SERVICE on the right machine.
      expect(dialled, kind).toEqual([['vm.example', 3270], ['vm.example', 3270]]);
      expect(session.isConnected(), `${kind} did not bring the session back up`).toBe(true);
    }
  });

  it('does NOT throw, and leaves no unhandled rejection, when there is nothing to reconnect to', async () => {
    // THE CASE EVERY REPLAY-MODE FRONT END SITS IN: `TN3270_GUI_REPLAY` and the gateway's
    // `--replay` never connect, so there is no target and `Session.reconnect()` rejects. It is
    // `async`, so that refusal arrives as a REJECTED PROMISE rather than as a throw -- and an
    // unhandled rejection ends the process on modern Node, which in the gateway would take every
    // other operator's session with it. `applyAction` contains it; this asserts that it does.
    const rejections: unknown[] = [];
    const onRejection = (err: unknown): void => { rejections.push(err); };
    process.on('unhandledRejection', onRejection);
    try {
      const { session } = newSession();
      expect(() => applyAction(session, { kind: 'enter' })).not.toThrow();
      expect(() => applyAction(session, { kind: 'clear' })).not.toThrow();
      // Two turns of the microtask queue, then a macrotask: Node reports an unhandled rejection at
      // the end of the turn in which it was rejected, so a `setTimeout` is what makes the absence
      // of a report meaningful rather than merely early.
      await new Promise((r) => { setTimeout(r, 0); });
      expect(rejections, 'a reconnect refusal escaped applyAction').toEqual([]);
      expect(session.isConnected()).toBe(false);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('refuses a SECOND press while the first reconnect is still in flight', async () => {
    // Two sockets to one mainframe is an LU leaked per impatient keypress: `connect()` tears down a
    // live predecessor, but both presses pass that check while `this.conn` is still undefined, so
    // the first socket would be replaced WITHOUT being closed and left open forever. x3270's own
    // guard is `PCONNECTED`, which covers the half-connected case; `isConnected()` does not, which
    // is why `Session` tracks the pending reconnect itself.
    // EVERY DIAL HANGS UNTIL RELEASED, and the array of connections IS the record of how many dials
    // happened -- the socket is pushed before the wait, so a refused press cannot hide inside it.
    const conns: FakeConnection[] = [];
    let release: (() => void) | undefined;
    const session = new Session({
      connect: async () => {
        const conn = new FakeConnection();
        conns.push(conn);
        await new Promise<void>((r) => { release = r; });
        return conn;
      },
    });
    const first = session.connect('vm.example', 3270);
    release!();
    await first;
    expect(conns).toHaveLength(1);
    conns[0]!.close();                                  // the host hangs up
    expect(session.isConnected()).toBe(false);

    release = undefined;
    applyAction(session, { kind: 'enter' });             // dials, then waits for `release`
    await Promise.resolve();
    expect(conns, 'the first press did not dial at all').toHaveLength(2);
    applyAction(session, { kind: 'clear' });             // must be refused, not dialled
    await Promise.resolve();
    expect(conns, 'a second press opened a second socket').toHaveLength(2);

    release!();                                         // let the in-flight reconnect finish
    await new Promise((r) => { setTimeout(r, 0); });
    expect(session.isConnected(), 'the in-flight reconnect never completed').toBe(true);
    // AND THE GUARD LIFTS: a flag left set would make the session unreconnectable for good, which is
    // a worse bug than the leak it prevents. Reachable only through a further disconnect.
    session.disconnect();
    applyAction(session, { kind: 'enter' });
    await Promise.resolve();
    expect(conns, 'the pending-reconnect guard was never cleared').toHaveLength(3);
    release!();
    await new Promise((r) => { setTimeout(r, 0); });
  });
});

describe('the keypad-era actions', () => {
  it('sysreq reaches Session.sysreq, which no front end could call before', () => {
    // `Session.sysreq()` has existed since stage 2b with nothing able to invoke it.
    //
    // A spy rather than the wire because the BYTES depend on the session and belong to core,
    // which asserts both forms separately: the TN3270E `[[T.IAC, T.AO]]` in
    // `core/test/tn3270e-session.test.ts` ("TN3270E SYSREQ"), which needs that file's
    // unexported `negotiateE()` helper, and the classic four-byte test request in
    // `core/test/session.test.ts` ("Sys Req on a classic session"). Duplicating either here
    // would only re-test core through a thinner harness. What this file owns is the dispatch.
    const { session } = newSession();
    const spy = vi.spyOn(session, 'sysreq');
    applyAction(session, { kind: 'sysreq' });
    expect(spy).toHaveBeenCalledOnce();
  });

  it('dup and fieldMark reach their OWN keyboard method, not each other s, and not sendAID', () => {
    // They are typed characters, and the `sendAID` assertion is the class of defect
    // pfAID/VALID_AIDS exist for. What a version that routed them through `sendAID` would
    // actually do is NOT a bogus byte on the wire, though: 0x1c/0x1e are not in `AID`,
    // `VALID_AIDS` is built from its values (constants.ts, cited by name because the line
    // moves), and `sendAID` throws `RangeError` before the connected check
    // (`Session.sendAID`'s AID-byte check, by name: the line moves), which `applyAction`
    // swallows. The result is a silently dead key --
    // which is why the assertion is worth keeping and why the claim needed correcting.
    //
    // EACH SPY IS ASSERTED BEFORE THE OTHER KEY IS PRESSED, and that ordering is the whole
    // test rather than a style choice. Written as two calls followed by two
    // `toHaveBeenCalledOnce()` assertions -- which is how it first shipped -- the test is
    // VACUOUS against a transposition: MEASURED, swapping the two case bodies to
    // `case 'dup': k.fieldMark()` / `case 'fieldMark': k.dup()` left all 13 tests green,
    // because each spy still saw exactly one call and `sendAID` was still untouched.
    // A swap is not cosmetic. The two differ in three ways (keyboard.ts:126, :164): the
    // byte written (0x1c versus 0x1e), the cursor rule (`'tab'` versus `'advance'`) and the
    // numeric-field policy (permitted versus refused). It would put the wrong control byte
    // on the wire, move the cursor wrongly, and invert the numeric rule.
    const { session } = newSession();
    const dup = vi.spyOn(session.keyboard, 'dup');
    const fm = vi.spyOn(session.keyboard, 'fieldMark');
    const aid = vi.spyOn(session, 'sendAID');

    applyAction(session, { kind: 'dup' });
    expect(dup, 'dup went somewhere other than Keyboard.dup').toHaveBeenCalledOnce();
    expect(fm, 'dup was routed to Keyboard.fieldMark').not.toHaveBeenCalled();

    applyAction(session, { kind: 'fieldMark' });
    expect(fm, 'fieldMark went somewhere other than Keyboard.fieldMark').toHaveBeenCalledOnce();
    expect(dup, 'fieldMark was routed to Keyboard.dup').toHaveBeenCalledOnce();

    expect(aid).not.toHaveBeenCalled();
  });

  it('newline reaches Keyboard.newline, and not one of the moves it sits beside', () => {
    // `Keyboard.newline()` has existed since stage 1 and no interactive front end could call it;
    // this case is what makes it reachable, so its own dispatch is worth an assertion.
    //
    // THE NEGATIVES ARE THE TEST. `case 'newline': k.newline()` sits between `tab` and
    // `backspace`, and its plausible defect is not a missing case -- `satisfies never` makes that
    // a compile error -- but a case body pointing at a NEIGHBOUR. Every candidate moves the cursor
    // and none of them throws, so an unasserted transposition is a silent wrong move: `tab()` goes
    // to the next FIELD rather than the next LINE, and `home()` to the first field on the screen.
    // On a screen with no fields those two even agree with `newline` about where to land, which is
    // why this asserts the CALL and not the resulting cursor.
    const { session } = newSession();
    const nl = vi.spyOn(session.keyboard, 'newline');
    const tab = vi.spyOn(session.keyboard, 'tab');
    const backTab = vi.spyOn(session.keyboard, 'backTab');
    const home = vi.spyOn(session.keyboard, 'home');
    const aid = vi.spyOn(session, 'sendAID');

    applyAction(session, { kind: 'newline' });
    expect(nl, 'newline went somewhere other than Keyboard.newline').toHaveBeenCalledOnce();
    expect(tab, 'newline was routed to Keyboard.tab').not.toHaveBeenCalled();
    expect(backTab, 'newline was routed to Keyboard.backTab').not.toHaveBeenCalled();
    expect(home, 'newline was routed to Keyboard.home').not.toHaveBeenCalled();
    // A local cursor move, NOT an AID: c3270 calls `Newline()` from its keypad and nothing goes on
    // the wire until the operator sends one.
    expect(aid, 'newline put an AID on the wire').not.toHaveBeenCalled();
  });

  it('REFUSES toggleKeypad, which is the front end s own business', () => {
    // Same reasoning as `quit`, and the same failure mode: a front end that forgot to
    // intercept this would show a dead button rather than an error, because the switch
    // below treats an unrecognised kind as a no-op. Throwing makes the omission loud.
    // See applyAction's docstring.
    //
    // `/does not handle toggleKeypad/` rather than `/toggleKeypad/`: MEASURED, the loose
    // pattern passes when the throw is replaced by a call to a nonexistent method, because
    // Node's own `TypeError: ...toggleKeypad is not a function` contains the word. The
    // deliberate refusal and an accidental crash are not the same outcome.
    const { session } = newSession();
    expect(() => applyAction(session, { kind: 'toggleKeypad' })).toThrow(/does not handle toggleKeypad/);
  });
});

/**
 * ONE ROW PER CASE IN `applyAction`'s SWITCH, AND THE ROW IS WHAT MAKES THE CASE FALSIFIABLE.
 *
 * ## THE DEFECT THIS EXISTS FOR, AND WHAT THE MUTATIONS ACTUALLY MEASURED
 *
 * Before this table, 13 of the switch's cases had NO test asserting their target. The reviewer's
 * finding was that transposing all thirteen at once -- `left`<->`right`, `up`<->`down`,
 * `tab`<->`backTab`, `home`<->`reset`, `backspace`<->`deleteChar`, `eraseEOF`<->`eraseInput`,
 * `clear`->`AID.ENTER` -- left the whole suite green, first at 1529 tests and then at 1643.
 *
 * RE-MEASURED HERE, AND THE FINDING NEEDS ONE CORRECTION. With `tsc --build packages/frontend` run
 * before the suite -- without it every other package reads a stale `frontend/dist` and sees nothing,
 * which is the most likely reading of "fully green" -- the 13-way transposition reddens 13 rows of
 * this table plus exactly TWO pre-existing tests, `tui/test/app.test.ts`'s "acts on both encodings
 * of an arrow key" and "completes the sequence when the rest arrives in time". Both observe a cursor
 * COLUMN, so both see `left`<->`right` and neither sees any of the other eleven: 11 of the 13 cases
 * were invisible to all 1643 tests even after a rebuild.
 *
 * The single swap is the sharper measurement. `left`<->`right` alone reddens exactly four tests in
 * 1669 -- the two rows here and those same two TUI tests, which is why the arrows are the ONE pair
 * this table did not have to catch alone. A table that only caught a mass transposition would be
 * much weaker than one that catches one case, so the swap was measured on its own.
 *
 * ## WHY EVERY ROW GETS ITS OWN `newSession()`, AND ASSERTS BEFORE THE NEXT ROW RUNS
 *
 * This is the part that decides whether the table is worth anything, and it is the exact defect
 * that made the `dup`/`fieldMark` test above vacuous when it first shipped: two `applyAction`
 * calls followed by two `toHaveBeenCalledOnce()` assertions are satisfied by a transposition,
 * because each spy still sees exactly one call. `it.each` gives each row its own session, its own
 * spies and its own pass/fail, so the pair of assertions below is evaluated with exactly ONE
 * action ever applied.
 *
 * ## WHAT THE TWO HALVES OF A ROW BUY
 *
 * `toHaveBeenCalledOnce()` on the target is what catches a swap, GIVEN the isolation above. The
 * `notCalled` partners are the diagnostic -- "left was routed to keyboard.right" instead of
 * "keyboard.left was not called" -- and the guard for the day someone folds these rows back into a
 * shared session, at which point the positive assertion stops catching anything and the partner
 * assertion is all that is left. They are also the reason a row names its partner explicitly
 * rather than the loop guessing: the plausible mis-wirings are a fact about 3270 semantics
 * (EraseEOF versus EraseInput, Tab versus Newline), not something derivable from the names.
 *
 * ## WHAT IS DELIBERATELY NOT HERE
 *
 * The correspondence between the SWITCH CASES and the union is not this table's job: `default:
 * action satisfies never` makes a missing case a compile error, and `npm run typecheck` covers
 * `src`. What no compiler can see is a case whose body calls the wrong method, which is all this
 * table asserts. The out-of-range `pf`/`pa` numbers have their own test above -- these rows are
 * the happy path only.
 */
interface Row {
  readonly action: Action;
  /** `keyboard.<method>` or `session.<method>`: the ONE call this case must make. */
  readonly target?: string;
  /** Targets that must NOT be called -- this case's plausible transposition partners. */
  readonly notCalled?: readonly string[];
  /** Asserted arguments, where the ARGUMENT is the behaviour: the AID byte, the text, the flag. */
  readonly args?: readonly unknown[];
  /** For the two kinds that throw instead of dispatching. A message pattern, never a bare throw. */
  readonly throws?: RegExp;
  /**
   * Connect the session before applying, for the rows whose dispatch DEPENDS on that.
   *
   * Only `enter` and `clear` need it, and they need it absolutely: while disconnected they
   * reconnect instead of sending, so a row that ran disconnected would assert the wrong half of the
   * behaviour. Everything else here is state-independent, and the note above the AID senders says
   * why the rest of the table deliberately stays unconnected.
   */
  readonly connected?: true;
}

/**
 * NOTE THE TWO NAMES THAT ARE NOT THE ACTION'S OWN, both verified in `core/src/keyboard.ts`:
 * `delete` dispatches to `Keyboard.deleteChar` (`delete` is a reserved word, keyboard.ts:413) and
 * `type` to `Keyboard.typeString` (keyboard.ts:88), NOT to the single-character `Keyboard.type`
 * (keyboard.ts:26). Every other action kind and the keyboard method it reaches share a name; the
 * session-level kinds (`enter`, `clear`, `pf`, `pa`, `attn`, `sysreq`) are named after the key
 * rather than the method, which is what the `target` column spells out.
 */
const ROWS: readonly Row[] = [
  // THE AID SENDERS. All four reach the same method, so the BYTE is the assertion: without it,
  // `case 'clear': session.sendAID(AID.ENTER)` -- one of the 13 transpositions -- would pass.
  // `sendAID` refuses on a disconnected session and `applyAction` swallows that, but the spy has
  // already recorded the call, so `pf` and `pa` need no `connect` here. The wire-level assertions
  // are above, where they belong.
  //
  // `enter` AND `clear` DO NEED ONE, and the reason is the behaviour, not the harness: while
  // disconnected those two RECONNECT and send nothing at all
  // (`actions.ts`'s `reconnectInstead`). `connected: true` is what keeps these two rows asserting
  // the AID rather than accidentally asserting the reconnect. Their partner list names
  // `session.reconnect` for the same reason the arrows name each other: the mis-wiring that renders
  // plausibly is a state test inverted, and it would send nothing to a live host while looking
  // exactly like a working key. The other direction has its own test above.
  { action: { kind: 'enter' }, target: 'session.sendAID', args: [AID.ENTER], connected: true,
    notCalled: ['keyboard.newline', 'session.reconnect'] },
  { action: { kind: 'clear' }, target: 'session.sendAID', args: [AID.CLEAR], connected: true,
    notCalled: ['keyboard.eraseInput', 'session.reconnect'] },
  // `pf`/`pa` carry an `n`, and the byte is the only thing distinguishing them from each other:
  // 0xf3 is PF3 and 0x6e is PA2 (constants.ts, x3270 3270ds.h).
  { action: { kind: 'pf', n: 3 }, target: 'session.sendAID', args: [0xf3],
    notCalled: ['session.sendAttn'] },
  { action: { kind: 'pa', n: 2 }, target: 'session.sendAID', args: [0x6e],
    notCalled: ['session.sendAttn'] },

  // THE CURSOR MOVES. Each names the opposite direction, which is the swap that renders
  // plausibly and is therefore invisible to every front-end test.
  { action: { kind: 'left' }, target: 'keyboard.left', notCalled: ['keyboard.right'] },
  { action: { kind: 'right' }, target: 'keyboard.right', notCalled: ['keyboard.left'] },
  { action: { kind: 'up' }, target: 'keyboard.up', notCalled: ['keyboard.down'] },
  { action: { kind: 'down' }, target: 'keyboard.down', notCalled: ['keyboard.up'] },
  // `home` and `reset` are each other's partner because `home`->`reset` was one of the measured
  // 13: both are single local operations that put the session in a plausible state.
  { action: { kind: 'home' }, target: 'keyboard.home',
    notCalled: ['keyboard.reset', 'keyboard.tab', 'keyboard.newline'] },
  { action: { kind: 'reset' }, target: 'keyboard.reset', notCalled: ['keyboard.home'] },
  // Tab, BackTab and Newline all move to somewhere else on the screen and none of them throws,
  // so an unasserted swap is a silently wrong move rather than a failure.
  { action: { kind: 'tab' }, target: 'keyboard.tab',
    notCalled: ['keyboard.backTab', 'keyboard.newline'] },
  { action: { kind: 'backTab' }, target: 'keyboard.backTab', notCalled: ['keyboard.tab'] },
  { action: { kind: 'newline' }, target: 'keyboard.newline',
    notCalled: ['keyboard.tab', 'keyboard.backTab', 'keyboard.home'] },

  // THE ERASERS, the two pairs where a swap is destructive rather than merely wrong: Backspace
  // destroys one character to the LEFT and Delete one under the cursor, and EraseEOF clears to the
  // end of ONE field while EraseInput clears EVERY unprotected field on the screen.
  { action: { kind: 'backspace' }, target: 'keyboard.backspace',
    notCalled: ['keyboard.deleteChar'] },
  { action: { kind: 'delete' }, target: 'keyboard.deleteChar', notCalled: ['keyboard.backspace'] },
  { action: { kind: 'eraseEOF' }, target: 'keyboard.eraseEOF', notCalled: ['keyboard.eraseInput'] },
  { action: { kind: 'eraseInput' }, target: 'keyboard.eraseInput', notCalled: ['keyboard.eraseEOF'] },

  // THE SESSION-LEVEL KEYS. Attn is a Telnet BREAK (RFC 1576 section 8). `Session.sysreq` is
  // two things: IAC AO under TN3270E, and a test request read on a classic session. Each row
  // names the other key, plus `sendAID` -- the mis-wiring the note in `actions.ts` traces.
  //
  // `sysreq`'s `session.sendAID` ABSENCE IS TRUE ONLY BECAUSE THIS TABLE RUNS DISCONNECTED, and
  // saying so is the point: the classic path DOES go through `sendAID(AID.SYSREQ)` -- that is
  // how it inherits x3270's key_AID keyboard lock -- and `Session.sysreq` returns at its
  // not-connected guard before reaching it here. What this row pins is the DISPATCH, that
  // `sysreq` reaches `sysreq` and not `sendAttn`. The bytes are core's business and are
  // asserted there, separately per path: `core/test/session.test.ts` ("Sys Req on a classic
  // session") and `core/test/tn3270e-session.test.ts` ("TN3270E SYSREQ").
  { action: { kind: 'attn' }, target: 'session.sendAttn',
    notCalled: ['session.sysreq', 'session.sendAID'] },
  { action: { kind: 'sysreq' }, target: 'session.sysreq',
    notCalled: ['session.sendAttn', 'session.sendAID'] },

  // TYPED CHARACTERS, not AIDs. The `sendAID` partner is added to every keyboard row below, so
  // these rows keep the assertion the standalone `dup`/`fieldMark` test makes without restating it.
  { action: { kind: 'dup' }, target: 'keyboard.dup', notCalled: ['keyboard.fieldMark'] },
  { action: { kind: 'fieldMark' }, target: 'keyboard.fieldMark', notCalled: ['keyboard.dup'] },
  // `typeString`, NOT `type`: see the note above the table. The text is asserted because dropping
  // it -- `k.typeString('')` -- is a passing no-op otherwise.
  //
  // `keyboard.type` IS DELIBERATELY NOT THE PARTNER HERE, and the attempt is worth recording:
  // `typeString` DELEGATES to `type` once per character (keyboard.ts:88-93), so
  // `not.toHaveBeenCalled()` on it fails against the correct code -- MEASURED, "Number of calls: 2"
  // for 'HI'. The transposition it would have guarded, `case 'type': k.type(action.text)`, is
  // caught by the positive assertion instead: `typeString` is then never called at all.
  { action: { kind: 'type', text: 'HI' }, target: 'keyboard.typeString', args: ['HI'],
    notCalled: ['keyboard.dup'] },
  // Read-then-set, so the ARGUMENT is the behaviour: a fresh keyboard has insert mode off, and
  // `setInsertMode(false)` here would be the toggle that never turns on.
  { action: { kind: 'toggleInsert' }, target: 'keyboard.setInsertMode', args: [true],
    notCalled: ['keyboard.reset'] },

  // THE TWO THAT THROW, which is the front end's business and not a dispatch at all. The patterns
  // match the DELIBERATE message: `/quit/` also matches Node's own `TypeError: session.quit is not
  // a function`, which is how two assertions on this branch passed against an unrelated crash.
  { action: { kind: 'quit' }, throws: /does not handle quit/ },
  { action: { kind: 'toggleKeypad' }, throws: /does not handle toggleKeypad/ },
];

/**
 * Spy on a dotted target, REFUSING a name that does not exist.
 *
 * The guard is not decoration: `expect(spy).not.toHaveBeenCalled()` on a spy for a misspelt
 * method is vacuously true, so a typo in a `notCalled` list would silently delete an assertion --
 * the same class of hole as the vacuous `dup`/`fieldMark` test this table was written to answer.
 */
function spyOnTarget(session: Session, target: string): ReturnType<typeof vi.spyOn> {
  const dot = target.indexOf('.');
  const host = (target.slice(0, dot) === 'keyboard' ? session.keyboard : session) as
    unknown as Record<string, unknown>;
  const method = target.slice(dot + 1);
  if (typeof host[method] !== 'function') {
    throw new Error(`the dispatch table names a method that does not exist: ${target}`);
  }
  return vi.spyOn(host as never, method as never);
}

describe('applyAction: the dispatch table, one falsifiable row per case', () => {
  it.each(ROWS)('routes $action.kind to its own target and to nothing else', async (row) => {
    // A FRESH SESSION PER ROW, and one `applyAction` call in it. See the header note: this is
    // what makes `toHaveBeenCalledOnce()` mean anything here.
    const { session } = newSession();
    // BEFORE THE SPIES: `connect` calls nothing this table watches, but a spy installed first would
    // see the connect's own bookkeeping if that ever changed. Only the two state-dependent rows ask
    // for it -- see `Row.connected`.
    if (row.connected === true) await session.connect('h', 23);

    if (row.throws !== undefined) {
      expect(() => applyAction(session, row.action)).toThrow(row.throws);
      return;
    }

    const target = spyOnTarget(session, row.target!);
    // Every keyboard case gets `session.sendAID` as an implicit partner: a local key that puts a
    // byte on the wire is a defect in its own right, and this is the cheap way to assert it for
    // all of them rather than 17 identical table entries.
    const partners = [...(row.notCalled ?? [])];
    if (row.target!.startsWith('keyboard.') && !partners.includes('session.sendAID')) {
      partners.push('session.sendAID');
    }
    const spies = partners.map((name) => [name, spyOnTarget(session, name)] as const);

    applyAction(session, row.action);

    // THE PARTNERS ARE ASSERTED FIRST, for the diagnostic and not for the coverage: a transposition
    // fails both halves, and this order reports it as "left was routed to keyboard.right" rather
    // than the "keyboard.left was not called" that leaves the reader to find where it went.
    for (const [name, spy] of spies) {
      expect(spy, `${row.action.kind} was routed to ${name}`).not.toHaveBeenCalled();
    }
    expect(target, `${row.action.kind} did not reach ${row.target}`).toHaveBeenCalledOnce();
    if (row.args !== undefined) {
      expect(target, `${row.action.kind} reached ${row.target} with the wrong argument`)
        .toHaveBeenCalledWith(...row.args);
    }
  });

  it('has a row for EVERY member of the Action union, and exactly one each', () => {
    // WITHOUT THIS THE TABLE ROTS SILENTLY: a new union member needs a new case (the compiler says
    // so) but nothing would demand a row, and the case would land as unfalsifiable as the 13 were.
    // The kinds are read out of the union's declaration at run time because no test file in this
    // repo is typechecked -- see `helpers/actionKinds.ts` for why that rules out a type-level trick.
    const kinds = actionKinds();
    expect(kinds.length, 'the Action union scan found too few kinds to be right')
      .toBeGreaterThanOrEqual(ACTION_KIND_FLOOR);
    for (const canary of ACTION_KIND_CANARIES) {
      expect(kinds, 'the Action union scan missed a known kind').toContain(canary);
    }

    const rows = ROWS.map((r) => r.action.kind);
    expect(new Set(rows).size, 'two rows claim the same kind').toBe(rows.length);
    // SET EQUALITY, BOTH WAYS: a union member with no row fails, and a row for a kind the union
    // dropped fails too -- the second being a row that asserts nothing about anything.
    expect([...rows].sort(), 'the table and the Action union disagree').toEqual([...kinds].sort());
    // AND AN EXACT COUNT, which the equality above does not give: deleting a member AND its row
    // together satisfies both sets while quietly shrinking what is pinned, and the count makes that
    // a decision someone has to write down. 25 members, 23 switch cases plus the 2 guards.
    expect(ROWS.length, 'the number of pinned cases changed').toBe(25);
  });
});
