import { describe, it, expect } from 'vitest';
import { Session, type Connection } from '@tn3270/core';
import { formatStatus } from '../src/status.js';

function offlineSession() {
  return new Session({ connect: () => { throw new Error('unused'); } });
}

/** Minimal connection so the session can report itself connected. */
function fakeConn(): Connection {
  return {
    write: () => {},
    close: () => {},
    onData: undefined,
    onClose: undefined,
    onError: undefined,
  };
}

async function connectedSession() {
  const s = new Session({ connect: () => fakeConn() });
  await s.connect('mvs', 3270);
  return s;
}

describe('formatStatus', () => {
  it('produces twelve space-separated fields', () => {
    const s = offlineSession();
    const fields = formatStatus(s, undefined, undefined).split(' ');
    expect(fields).toHaveLength(12);
  });

  it('reports a disconnected session', () => {
    const s = offlineSession();
    const f = formatStatus(s, undefined, undefined).split(' ');
    expect(f[0]).toBe('U');   // unlocked
    expect(f[1]).toBe('U');   // unformatted
    expect(f[2]).toBe('U');   // unprotected
    expect(f[3]).toBe('N');   // not connected
    expect(f[4]).toBe('N');   // no mode
    expect(f[5]).toBe('2');
    expect(f[6]).toBe('24');
    expect(f[7]).toBe('80');
    expect(f[8]).toBe('0');
    expect(f[9]).toBe('0');
    expect(f[10]).toBe('0x0');
    expect(f[11]).toBe('-');
  });

  it('reports the host when connected', async () => {
    const s = await connectedSession();
    const f = formatStatus(s, 'mvs:3270', undefined).split(' ');
    expect(f[3]).toBe('C(mvs:3270)');
    // Connected but not yet negotiated into 3270 mode.
    expect(f[4]).toBe('P');
  });

  it('reports formatting and protection at the cursor', () => {
    const s = offlineSession();
    s.screen.setFieldAttribute(0, 0x20); // protected
    s.screen.cursor = 1;
    const f = formatStatus(s, undefined, undefined).split(' ');
    expect(f[1]).toBe('F');
    expect(f[2]).toBe('P');
  });

  it('reports the cursor as 0-based row and column', () => {
    const s = offlineSession();
    s.screen.cursor = 81; // row 2, col 2 in 1-based terms
    const f = formatStatus(s, undefined, undefined).split(' ');
    expect(f[8]).toBe('1');
    expect(f[9]).toBe('1');
  });

  it('reports elapsed command time when given', () => {
    const s = offlineSession();
    const f = formatStatus(s, undefined, 0.25).split(' ');
    expect(f[11]).toBe('0.250');
  });

  it('reports E when the keyboard is locked by an error', () => {
    const s = offlineSession();
    s.oia.programCheck(754);
    const f = formatStatus(s, undefined, undefined).split(' ');
    expect(f[0]).toBe('E');
  });
});
