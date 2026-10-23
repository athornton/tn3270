import { describe, it, expect } from 'vitest';
import { Session, KeyboardState, type Connection } from '@tn3270/core';
import { applyPaste } from '../src/pasteAction.js';

/**
 * COPIED FROM `actions.test.ts:9-21`, NOT IMPORTED: `newSession` is a local function there, not an
 * exported helper (`test/helpers/` holds only `actionKinds.ts`). Checked before writing this --
 * importing it would not have compiled.
 */
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

describe('applyPaste', () => {
  it('reports nothing when every character landed', () => {
    const { session } = newSession();
    const r = applyPaste(session, 'AB');
    expect(r.warning, 'a clean paste must not warn').toBeUndefined();
    expect(r.typed).toBe(2);
  });

  it('reports REMEDY-FIRST when the paste stopped early', () => {
    /*
      AN INHIBITED KEYBOARD IS THE REACHABLE `reason`: `pasteString` checks
      `keyboard.oia.isInhibited()` and returns `reason: 'keyboard locked'` having typed nothing,
      which is what an operator meets by pasting while the host holds the keyboard.
    */
    const { session } = newSession();
    session.keyboard.oia.inhibit(KeyboardState.SystemWait);
    const r = applyPaste(session, 'ABC');
    expect(r.warning, 'a stopped paste must say so').toMatch(/^paste stopped: keyboard locked/);
    expect(r.warning).toContain('0 of 3 characters');
  });

  it('reports SHORT when characters were dropped without a reason', () => {
    /*
      THE OTHER WARNING ARM, KEPT BECAUSE IT IS REACHABLE: `paste.test.ts:142-149` produces
      exactly this -- a field attribute of 0x20 is PROTECTED, so `keyboard.type()` refuses the
      first character and `pasteString` returns with `dropped > 0` and NO `reason`. The screen
      belongs to the Session here rather than being constructed standalone, because `applyPaste`
      takes the Session and must read the right one off it.
    */
    const { session } = newSession();
    session.screen.setFieldAttribute(0, 0x20);
    session.screen.cursor = 1;
    const r = applyPaste(session, 'ABC');
    expect(r.warning, 'a short paste must say so').toMatch(/^paste short: /);
    expect(r.warning).toContain('(field full or protected)');
    expect(r.dropped).toBeGreaterThan(0);
  });
});
