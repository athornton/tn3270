import { describe, it, expect, vi } from 'vitest';
import { Session, type Connection, type SessionOptions } from '../src/session.js';
import {
  TelnetCmd as T, TelnetOpt as O, TelnetSubopt as S, SnaCmd, Order, AID, FA,
} from '../src/constants.js';
import { KeyboardState, Oia } from '../src/oia.js';
import { encodeAddress } from '../src/address.js';
import type { KeyAction } from '../src/keyAction.js';

/**
 * `Session.run`: the one route for operator actions (spec section A), its typeahead
 * queue and drain.
 *
 * Copied from `session.test.ts`'s `FakeConnection`/`newSession` rather than imported,
 * per the plan's instruction not to export test helpers from that file.
 */
class FakeConnection implements Connection {
  sent: number[] = [];
  closed = false;
  onData: ((b: Uint8Array) => void) | undefined;
  onClose: (() => void) | undefined;
  onError: ((e: Error) => void) | undefined;

  write(b: Uint8Array): void { this.sent.push(...b); }
  close(): void { this.closed = true; this.onClose?.(); }

  /** Test helper: pretend the host sent these bytes. */
  host(...bytes: number[]): void { this.onData?.(Uint8Array.from(bytes)); }

  /** Negotiate into 3270 mode the way a real host does. */
  negotiate(): void {
    this.host(T.IAC, T.DO, O.TERMINAL_TYPE);
    this.host(T.IAC, T.SB, O.TERMINAL_TYPE, S.SEND, T.IAC, T.SE);
    this.host(T.IAC, T.DO, O.EOR, T.IAC, T.WILL, O.EOR);
    this.host(T.IAC, T.DO, O.BINARY, T.IAC, T.WILL, O.BINARY);
    this.sent = [];
  }
}

function newSession(opts: Partial<SessionOptions> = {}) {
  const conn = new FakeConnection();
  const session = new Session({ connect: () => conn, ...opts });
  return { session, conn };
}

/**
 * A connected session with one unformatted-no-more screen: an Erase/Write with WCC
 * 0xc3 (restore keyboard, reset MDT) and a single unprotected field starting at
 * buffer address 1 (`Order.SF` at address 0 opens a field whose first DATA cell is
 * address 1 -- the field attribute itself occupies address 0).
 */
async function connectedWithField() {
  const { session, conn } = newSession();
  await session.connect('localhost', 3270);
  conn.negotiate();
  conn.host(SnaCmd.EW, 0xc3, Order.SF, 0x00, T.IAC, T.EOR);
  conn.sent = [];
  return { session, conn };
}

/**
 * A connected session with a PROTECTED field (attr 0, data address 1) followed
 * by an ordinary unprotected one (attr 10, data 11-): the protected field is
 * what raises `X Protected`, the second is what a clear-then-act key (Tab,
 * Home, ...) lands in.
 */
async function connectedWithProtectedField() {
  const { session, conn } = newSession();
  await session.connect('localhost', 3270);
  conn.negotiate();
  conn.host(
    SnaCmd.EW, 0xc3,
    Order.SF, FA.PROTECT,
    Order.SBA, ...encodeAddress(10, session.screen.size),
    Order.SF, 0x00,
    T.IAC, T.EOR,
  );
  conn.sent = [];
  return { session, conn };
}

/** A connected session with one NUMERIC, unprotected field (attr 0, data 1-). */
async function connectedWithNumericField() {
  const { session, conn } = newSession();
  await session.connect('localhost', 3270);
  conn.negotiate();
  conn.host(SnaCmd.EW, 0xc3, Order.SF, FA.NUMERIC, T.IAC, T.EOR);
  conn.sent = [];
  return { session, conn };
}

/**
 * A connected session with a two-cell unprotected field (attr 0, data 1-2)
 * followed immediately by a protected one (attr 3): just big enough to hold
 * two characters and no NUL to spare, for an insert-mode Overflow.
 */
async function connectedWithTinyField() {
  const { session, conn } = newSession();
  await session.connect('localhost', 3270);
  conn.negotiate();
  conn.host(
    SnaCmd.EW, 0xc3,
    Order.SF, 0x00,
    Order.SBA, ...encodeAddress(3, session.screen.size),
    Order.SF, FA.PROTECT,
    T.IAC, T.EOR,
  );
  conn.sent = [];
  return { session, conn };
}

describe('Session.run: the unlocked path (Task 1)', () => {
  it('types into the field and reports done', async () => {
    const { session } = await connectedWithField();
    session.keyboard.moveCursor(1);

    expect(session.run({ kind: 'type', text: 'AB' })).toBe('done');

    expect(session.screen.cellAt(1).ebcdic).toBe(0xc1); // A
    expect(session.screen.cellAt(2).ebcdic).toBe(0xc2); // B
  });

  it('moves the cursor for a movement action', async () => {
    const { session } = await connectedWithField();
    session.keyboard.moveCursor(0);

    expect(session.run({ kind: 'tab' })).toBe('done');

    // The only typable field on this screen starts at address 1.
    expect(session.screen.cursor).toBe(1);
  });

  it('puts the AID on the wire for an enter action', async () => {
    const { session, conn } = await connectedWithField();

    expect(session.run({ kind: 'enter' })).toBe('done');

    expect(conn.sent[0]).toBe(AID.ENTER);
  });

  it('drops the action and changes nothing when not connected', () => {
    const { session } = newSession();
    const before = session.screen.cellAt(0).ebcdic;

    expect(session.run({ kind: 'type', text: 'A' })).toBe('dropped');

    expect(session.screen.cellAt(0).ebcdic).toBe(before);
  });

  it('shows the typeahead queue as a standalone T part in the OIA', () => {
    const oia = new Oia();
    oia.connected = true;

    expect(oia.toText().split('  ')).not.toContain('T');

    oia.typeahead = true;
    expect(oia.toText().split('  ')).toContain('T');

    oia.typeahead = false;
    expect(oia.toText().split('  ')).not.toContain('T');
  });
});

describe('Session.run: the typeahead queue under a host lock (Task 2)', () => {
  it('queues a type action behind an Enter, leaving the screen unchanged', async () => {
    const { session } = await connectedWithField();
    session.keyboard.moveCursor(1);
    expect(session.run({ kind: 'enter' })).toBe('done');
    expect(session.oia.keyboard).toBe(KeyboardState.SystemWait);

    const r = session.run({ kind: 'type', text: 'X' });

    expect(r).toBe('queued');
    expect(session.oia.typeahead).toBe(true);
    expect(session.screen.cellAt(1).ebcdic).toBe(0x00);
  });

  it('runs a queued action when a keyboard-restore write unlocks, and emits screen', async () => {
    const { session, conn } = await connectedWithField();
    session.keyboard.moveCursor(1);
    session.run({ kind: 'enter' });
    session.run({ kind: 'type', text: 'X' });

    const onScreen = vi.fn();
    session.on('screen', onScreen);
    conn.host(SnaCmd.W, 0x02, T.IAC, T.EOR); // bare Write, WCC keyboard-restore

    expect(session.oia.keyboard).toBe(KeyboardState.Unlocked);
    expect(session.oia.typeahead).toBe(false);
    expect(session.screen.cellAt(1).ebcdic).toBe(0xe7); // X
    expect(onScreen).toHaveBeenCalled();
  });

  it('drains an AID-then-type queue one unlock at a time, pausing at the queued AID', async () => {
    const { session, conn } = await connectedWithField();
    session.keyboard.moveCursor(1);
    session.run({ kind: 'enter' }); // locks: SystemWait
    session.run({ kind: 'type', text: 'X' });
    session.run({ kind: 'enter' }); // queued too: still locked
    session.run({ kind: 'type', text: 'Y' });
    expect(session.oia.typeahead).toBe(true);

    conn.sent = [];
    conn.host(SnaCmd.W, 0x02, T.IAC, T.EOR); // first restore

    // X was typed, then the queued Enter sent an AID (locking again), so Y is
    // still queued and the indicator still shows it.
    expect(session.screen.cellAt(1).ebcdic).toBe(0xe7); // X
    expect(conn.sent[0]).toBe(AID.ENTER);
    expect(session.oia.keyboard).toBe(KeyboardState.SystemWait);
    expect(session.oia.typeahead).toBe(true);

    conn.host(SnaCmd.W, 0x02, T.IAC, T.EOR); // second restore

    // Y lands at address 2, not 1: typing X auto-advanced the cursor (`advanceAfterType`)
    // before the queued Enter locked the keyboard again, and nothing moved it back.
    expect(session.screen.cellAt(2).ebcdic).toBe(0xe8); // Y
    expect(session.oia.typeahead).toBe(false);
    expect(session.oia.keyboard).toBe(KeyboardState.Unlocked);
  });

  it('queues under AwaitingFirstWrite and drains on the first write', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    expect(session.oia.keyboard).toBe(KeyboardState.AwaitingFirstWrite);

    const r = session.run({ kind: 'type', text: 'A' });
    expect(r).toBe('queued');
    expect(session.oia.typeahead).toBe(true);

    // Erase/Write resets the cursor to 0 (`screen.clear()`), which is the field's own
    // attribute byte -- `fieldAt(0)` finds it by scanning backward and returns the SAME
    // field (`screen.ts`'s `fieldAt`/`makeField`) -- so without an explicit `Order.IC`
    // the drained type would corrupt the attribute rather than land in a data cell. A
    // live host positions the cursor the same way, with its own IC order.
    conn.host(SnaCmd.EW, 0xc3, Order.SF, 0x00, Order.IC, T.IAC, T.EOR);

    // The write both unlocks (restore bit) and defines the field the queued
    // type lands in, exactly as a live VM/370 banner does.
    expect(session.screen.cellAt(1).ebcdic).toBe(0xc1); // A
    expect(session.oia.typeahead).toBe(false);
  });

  it('queues under EnterInhibit, a non-OERR host lock', async () => {
    const { session, conn } = await connectedWithField();
    session.keyboard.moveCursor(1);
    session.oia.enterInhibit();
    expect(session.oia.keyboard).toBe(KeyboardState.EnterInhibit);

    expect(session.run({ kind: 'type', text: 'A' })).toBe('queued');
    expect(session.oia.typeahead).toBe(true);

    conn.host(SnaCmd.W, 0x02, T.IAC, T.EOR); // restore releases it too

    expect(session.screen.cellAt(1).ebcdic).toBe(0xc1); // A
  });

  it('queues under MinusFunction, a non-OERR host lock', async () => {
    const { session, conn } = await connectedWithField();
    session.keyboard.moveCursor(1);
    session.oia.inhibit(KeyboardState.MinusFunction);

    expect(session.run({ kind: 'type', text: 'A' })).toBe('queued');
    expect(session.oia.typeahead).toBe(true);

    conn.host(SnaCmd.W, 0x02, T.IAC, T.EOR);

    expect(session.screen.cellAt(1).ebcdic).toBe(0xc1); // A
  });

  it('empties the queue and clears the indicator on disconnect; a new connection drains nothing old', async () => {
    const conns: FakeConnection[] = [];
    const session = new Session({
      connect: () => {
        const c = new FakeConnection();
        conns.push(c);
        return c;
      },
    });
    await session.connect('localhost', 3270);
    conns[0]!.negotiate();
    conns[0]!.host(SnaCmd.EW, 0xc3, Order.SF, 0x00, T.IAC, T.EOR);
    session.keyboard.moveCursor(1);
    session.run({ kind: 'enter' }); // locks: SystemWait
    session.run({ kind: 'type', text: 'X' }); // queued, never performed
    expect(session.oia.typeahead).toBe(true);

    session.disconnect();

    expect(session.oia.typeahead).toBe(false);

    await session.connect('localhost', 3270);
    conns[1]!.negotiate();
    conns[1]!.host(SnaCmd.EW, 0xc3, Order.SF, 0x00, T.IAC, T.EOR); // fresh field, restore

    // Nothing from the first connection's queue ran on the second one's unlock.
    expect(session.screen.cellAt(1).ebcdic).toBe(0x00);
    expect(session.oia.typeahead).toBe(false);
  });

  it('drops and rings the alarm during a transfer, under a host lock, queuing nothing', async () => {
    const { session } = await connectedWithField();
    session.keyboard.moveCursor(1);
    session.run({ kind: 'enter' }); // host lock: SystemWait
    session.transferring = true;

    const onAlarm = vi.fn();
    session.on('alarm', onAlarm);

    const r = session.run({ kind: 'type', text: 'X' });

    expect(r).toBe('dropped');
    expect(onAlarm).toHaveBeenCalledTimes(1);
    expect(session.oia.typeahead).toBe(false);
    expect(session.screen.cellAt(1).ebcdic).toBe(0x00);
  });
});

describe('Session.run: operator-error lock (Task 3, oerrLock)', () => {
  /**
   * Everything OERR_CLEARS does NOT name: typed characters, the AIDs, Attn,
   * SysReq and insert all get DROPPED under an operator error rather than
   * cleared-and-acted (spec section A step 4; x3270's key_Character checks
   * `kybdlock` unconditionally and is not wrapped in OERR_CLEAR_OR_ENQ,
   * kybd.c:146-157 vs :1200-1208).
   */
  const dropKinds: KeyAction[] = [
    { kind: 'type', text: 'B' },
    { kind: 'backspace' },
    { kind: 'delete' },
    { kind: 'newline' },
    { kind: 'dup' },
    { kind: 'fieldMark' },
    { kind: 'enter' },
    { kind: 'pf', n: 1 },
    { kind: 'attn' },
    { kind: 'sysreq' },
    { kind: 'insert' },
    { kind: 'toggleInsert' },
  ];

  it('drops every non-clearing action with the alarm, leaving X Protected up', async () => {
    const { session, conn } = await connectedWithProtectedField();
    session.keyboard.moveCursor(1); // inside the protected field

    // Raise the error: the FIRST action on an unlocked keyboard runs immediately
    // (there is no lock yet to drop it against) and the field itself refuses it.
    expect(session.run({ kind: 'type', text: 'A' })).toBe('refused');
    expect(session.oia.keyboard).toBe(KeyboardState.ProtectedField);

    for (const action of dropKinds) {
      conn.sent = [];
      const onAlarm = vi.fn();
      session.on('alarm', onAlarm);

      const r = session.run(action);

      expect(r, action.kind).toBe('dropped');
      expect(onAlarm, action.kind).toHaveBeenCalledTimes(1);
      expect(conn.sent, action.kind).toEqual([]);
      expect(session.screen.cellAt(1).ebcdic, action.kind).toBe(0x00);
      expect(session.oia.keyboard, action.kind).toBe(KeyboardState.ProtectedField);

      session.off('alarm', onAlarm);
    }
  });

  it('drops a non-clearing action under Overflow too, not just Protected', async () => {
    // Written before Task 7 existed, when `numericLock` had no off switch and
    // `X Numeric` could not be raised without it: Overflow, raised by insert
    // mode finding no room, stood in for the `X Numeric` case the plan asks
    // for. Kept as its own test now that Task 7 exists -- the real `X
    // Numeric` case is the one right after this.
    const { session } = await connectedWithTinyField();
    session.keyboard.moveCursor(1);
    session.screen.setChar(1, 0xc1);
    session.screen.setChar(2, 0xc2); // field full: no NUL for insert to consume
    session.keyboard.setInsertMode(true);

    expect(session.run({ kind: 'type', text: 'X' })).toBe('refused');
    expect(session.oia.keyboard).toBe(KeyboardState.Overflow);

    const onAlarm = vi.fn();
    session.on('alarm', onAlarm);

    const r = session.run({ kind: 'type', text: 'Y' });

    expect(r).toBe('dropped');
    expect(onAlarm).toHaveBeenCalledTimes(1);
    expect(session.oia.keyboard).toBe(KeyboardState.Overflow);
    expect(session.screen.cellAt(1).ebcdic).toBe(0xc1); // unchanged
  });

  /**
   * THE `X Numeric` CASE ITSELF, now that Task 7 exists: `numericLock` is
   * off by default (spec section D), so it has to be turned on to raise the
   * error at all -- `run`'s drop/alarm behaviour for a non-clearing action
   * under ANY `KYBDLOCK_IS_OERR` state is otherwise identical to the
   * Overflow case above, which is why that one stood in for this one while
   * Task 7 did not exist yet.
   */
  it('drops a non-clearing action under a Numeric error too, once numericLock is on', async () => {
    const { session } = await connectedWithNumericField();
    session.keyboard.numericLock = true;
    session.keyboard.moveCursor(1);

    expect(session.run({ kind: 'type', text: 'A' })).toBe('refused');
    expect(session.oia.keyboard).toBe(KeyboardState.Numeric);

    const onAlarm = vi.fn();
    session.on('alarm', onAlarm);

    const r = session.run({ kind: 'type', text: 'B' });

    expect(r).toBe('dropped');
    expect(onAlarm).toHaveBeenCalledTimes(1);
    expect(session.oia.keyboard).toBe(KeyboardState.Numeric);
    expect(session.screen.cellAt(1).ebcdic).toBe(0x00); // unchanged
  });

  /** OERR_CLEARS: clear the error, then run as if the keyboard had been unlocked. */
  const movementClears: KeyAction[] = [
    { kind: 'tab' }, { kind: 'backTab' }, { kind: 'home' },
    { kind: 'up' }, { kind: 'down' }, { kind: 'left' }, { kind: 'right' },
  ];

  it('clears the error and acts for each movement key, even starting inside the protected field', async () => {
    // None of these seven touch `field.protected` themselves (they only move
    // the cursor), unlike EraseEOF below -- so starting inside the very field
    // that raised the error still comes out unlocked, for all seven.
    for (const action of movementClears) {
      const { session } = await connectedWithProtectedField();
      session.keyboard.moveCursor(1);
      session.run({ kind: 'type', text: 'A' }); // raises X Protected
      expect(session.oia.keyboard, action.kind).toBe(KeyboardState.ProtectedField);

      const before = session.screen.cursor;
      const r = session.run(action);

      expect(r, action.kind).toBe('done');
      expect(session.oia.isInhibited(), action.kind).toBe(false);
      expect(session.screen.cursor, action.kind).not.toBe(before);
    }
  });

  it('EraseInput clears the error and acts, even starting inside the protected field', async () => {
    const { session } = await connectedWithProtectedField();
    session.keyboard.moveCursor(1);
    session.run({ kind: 'type', text: 'A' });
    expect(session.oia.keyboard).toBe(KeyboardState.ProtectedField);

    const r = session.run({ kind: 'eraseInput' });

    expect(r).toBe('done');
    expect(session.oia.isInhibited()).toBe(false);
    expect(session.screen.cursor).toBe(11); // homed to the one unprotected field
  });

  it('EraseEOF clears a Numeric error and acts, when the field itself is unprotected', async () => {
    const { session } = await connectedWithNumericField();
    // CHANGED (Task 7, spec section D): `numericLock` is off by default, so
    // 'A' would simply go in -- turned on here to still raise the error this
    // test is about.
    session.keyboard.numericLock = true;
    session.keyboard.moveCursor(1);
    session.screen.setChar(1, 0xc1); // leftover data for the erase to null out
    session.run({ kind: 'type', text: 'A' }); // refused: not a digit
    expect(session.oia.keyboard).toBe(KeyboardState.Numeric);

    const r = session.run({ kind: 'eraseEOF' });

    expect(r).toBe('done');
    expect(session.oia.isInhibited()).toBe(false);
    expect(session.screen.cellAt(1).ebcdic).toBe(0x00);
  });

  /**
   * THE SOURCE DISAGREES WITH THE PLAN'S WORDING HERE, and this test is why:
   * `EraseEOF_action` runs `OERR_CLEAR_OR_ENQ(AnEraseEOF)` and THEN its own
   * `if (FA_IS_PROTECTED(fa) || ea_buf[baddr].fa) return
   * operator_error(KL_OERR_PROTECTED, true);` (Common/kybd.c, EraseEOF_action,
   * ~3018-3025) -- so EraseEOF run from INSIDE the protected field that raised
   * the error clears the OLD error and immediately raises a NEW, identical
   * one. It does not come out unlocked, unlike the other eight OERR_CLEARS
   * members (none of which re-examine `field.protected`). `Keyboard.eraseEOF`
   * has the identical `f.protected` check, so it matches. The plan's "clears
   * the error AND acts" is accurate about the ACT, just not about every act
   * ending unlocked.
   */
  it('EraseEOF clears and re-locks with a fresh Protected error, run from inside the protected field', async () => {
    const { session } = await connectedWithProtectedField();
    session.keyboard.moveCursor(1);
    session.run({ kind: 'type', text: 'A' });
    expect(session.oia.keyboard).toBe(KeyboardState.ProtectedField);

    const r = session.run({ kind: 'eraseEOF' });

    // `perform`'s 'eraseEOF' case returns 'done' unconditionally -- it does not
    // see eraseEOF's own internal refusal, only that the call ran.
    expect(r).toBe('done');
    expect(session.oia.keyboard).toBe(KeyboardState.ProtectedField);
  });
});

describe('Session.run: Reset half/full, and insert mode off on an AID/Reset/restore (Task 4)', () => {
  it('a Reset with the queue non-empty flushes it and leaves the keyboard locked (half reset)', async () => {
    const { session, conn } = await connectedWithField();
    session.keyboard.moveCursor(1);
    session.run({ kind: 'enter' }); // locks: SystemWait
    session.run({ kind: 'type', text: 'A' }); // queued
    session.run({ kind: 'type', text: 'B' }); // queued
    expect(session.oia.typeahead).toBe(true);

    const r = session.run({ kind: 'reset' });

    expect(r).toBe('done');
    expect(session.oia.typeahead).toBe(false);
    // Still locked: do_reset's half reset returns before touching the lock at all
    // (kybd.c ~2015-2028).
    expect(session.oia.keyboard).toBe(KeyboardState.SystemWait);

    // A second Reset, queue now empty, does the rest.
    expect(session.run({ kind: 'reset' })).toBe('done');
    expect(session.oia.keyboard).toBe(KeyboardState.Unlocked);

    // And the flushed queue never ran, even once unlocked and a write arrives to drain.
    conn.host(SnaCmd.W, 0x02, T.IAC, T.EOR);
    expect(session.screen.cellAt(1).ebcdic).toBe(0x00);
  });

  it('a Reset with an empty queue unlocks and turns insert mode off', async () => {
    const { session } = await connectedWithField();
    session.keyboard.setInsertMode(true);
    session.oia.inhibit(KeyboardState.EnterInhibit); // a host lock, queue empty

    const r = session.run({ kind: 'reset' });

    expect(r).toBe('done');
    expect(session.oia.keyboard).toBe(KeyboardState.Unlocked);
    expect(session.keyboard.insertMode).toBe(false);
  });

  it('Reset while not connected turns insert mode off and does nothing else (do_reset\'s !CONNECTED arm)', () => {
    const { session } = newSession();
    session.keyboard.setInsertMode(true);

    const r = session.run({ kind: 'reset' });

    expect(r).toBe('done');
    expect(session.keyboard.insertMode).toBe(false);
  });

  it('an AID turns insert mode off, as key_AID does for every AID (kybd.c:920)', async () => {
    const { session } = await connectedWithField();
    session.keyboard.moveCursor(1);
    session.keyboard.setInsertMode(true);

    expect(session.run({ kind: 'enter' })).toBe('done');

    expect(session.keyboard.insertMode).toBe(false);
  });

  it('a host write WITH keyboard-restore turns insert mode off', async () => {
    const { session, conn } = await connectedWithField();
    session.keyboard.setInsertMode(true);

    conn.host(SnaCmd.W, 0x02, T.IAC, T.EOR); // WCC keyboard-restore

    expect(session.keyboard.insertMode).toBe(false);
  });

  it('a host write WITHOUT keyboard-restore leaves insert mode alone', async () => {
    const { session, conn } = await connectedWithField();
    session.keyboard.setInsertMode(true);

    conn.host(SnaCmd.W, 0x00, T.IAC, T.EOR); // WCC with no restore bit

    expect(session.keyboard.insertMode).toBe(true);
  });

  it('run({kind:"insert"}) sets insert on and stays on when pressed twice', async () => {
    const { session } = await connectedWithField();

    expect(session.run({ kind: 'insert' })).toBe('done');
    expect(session.keyboard.insertMode).toBe(true);
    expect(session.run({ kind: 'insert' })).toBe('done');
    expect(session.keyboard.insertMode).toBe(true);
  });

  it('run({kind:"toggleInsert"}) twice leaves insert mode off again', async () => {
    const { session } = await connectedWithField();

    expect(session.run({ kind: 'toggleInsert' })).toBe('done');
    expect(session.keyboard.insertMode).toBe(true);
    expect(session.run({ kind: 'toggleInsert' })).toBe('done');
    expect(session.keyboard.insertMode).toBe(false);
  });
});
