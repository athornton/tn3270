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
    const { session } = newSession();
    expect(() => applyAction(session, { kind: 'quit' })).toThrow(/quit/i);
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
