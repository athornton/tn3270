import { describe, it, expect } from 'vitest';
import { Session, type Connection, type SessionOptions } from '../src/session.js';
import {
  TelnetCmd as T, TelnetOpt as O, TelnetSubopt as S, SnaCmd, Order, AID,
} from '../src/constants.js';
import { Oia } from '../src/oia.js';

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
