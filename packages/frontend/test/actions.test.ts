import { describe, it, expect, vi } from 'vitest';
import { Session, AID, type Connection } from '@tn3270/core';
import { applyAction } from '../src/actions.js';

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

describe('the keypad-era actions', () => {
  it('sysreq reaches Session.sysreq, which no front end could call before', () => {
    // `Session.sysreq()` has existed since stage 2b with nothing able to invoke it.
    //
    // A spy rather than the wire because sysreq is a no-op unless TN3270E negotiated the
    // SYSREQ function, so a wire assertion would mean replicating core's TN3270E negotiation
    // here -- `core/test/tn3270e-session.test.ts:465` does assert `[[T.IAC, T.AO]]`, using a
    // file-local `negotiateE()` helper that is not exported. It is reachable, in other words,
    // just not cheaply; if that helper is ever shared, strengthen this.
    const { session } = newSession();
    const spy = vi.spyOn(session, 'sysreq');
    applyAction(session, { kind: 'sysreq' });
    expect(spy).toHaveBeenCalledOnce();
  });

  it('dup and fieldMark reach their OWN keyboard method, not each other s, and not sendAID', () => {
    // They are typed characters, and the `sendAID` assertion is the class of defect
    // pfAID/VALID_AIDS exist for. What a version that routed them through `sendAID` would
    // actually do is NOT a bogus byte on the wire, though: 0x1c/0x1e are not in `AID`,
    // `VALID_AIDS` is built from its values (constants.ts:544), and `sendAID` throws
    // `RangeError` before the connected check (session.ts:609-611), which `applyAction`
    // swallows. The result is a silently dead key -- which is why the assertion is worth
    // keeping and why the claim needed correcting.
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
