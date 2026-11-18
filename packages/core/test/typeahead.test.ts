import { describe, it, expect, vi } from 'vitest';
import { Session, type Connection, type SessionOptions } from '../src/session.js';
import {
  TelnetCmd as T, TelnetOpt as O, TelnetSubopt as S, SnaCmd, Order, AID,
} from '../src/constants.js';
import { KeyboardState, Oia } from '../src/oia.js';

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
