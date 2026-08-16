import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTrace } from '../src/trace.js';
import { Session } from '../src/session.js';
import { TelnetCmd as T } from '../src/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const refDir = join(here, '..', '..', 'fixtures', 'x3270');

/**
 * Replay the host side of an x3270 capture into our core and compare what WE
 * would send against what x3270 actually sent.
 *
 * Excluded from comparison, each exclusion deliberate and recorded here:
 *  - Telnet negotiation (option order legitimately varies between clients).
 *  - Records containing typed passwords, which are redacted in the fixture.
 */
function ourReplies(traceText: string): number[][] {
  const events = parseTrace(traceText);
  const replies: number[][] = [];
  const conn = {
    write: (b: Uint8Array) => {
      const bytes = Array.from(b);
      // Skip pure negotiation (IAC followed by WILL/WONT/DO/DONT/SB).
      const isNegotiation = bytes[0] === T.IAC && bytes[1] !== undefined
        && bytes[1] >= T.SB && bytes[1] <= T.DONT;
      if (!isNegotiation) replies.push(bytes);
    },
    close: () => {},
    onData: undefined as ((b: Uint8Array) => void) | undefined,
    onClose: undefined as (() => void) | undefined,
    onError: undefined as ((e: Error) => void) | undefined,
  };
  const session = new Session({ connect: () => conn });
  void session.connect('replay', 0);
  for (const ev of events) {
    if (ev.dir === 'recv') conn.onData?.(ev.bytes);
  }
  return replies;
}

function theirReplies(traceText: string): number[][] {
  return parseTrace(traceText)
    .filter((e) => e.dir === 'send')
    .map((e) => Array.from(e.bytes))
    .filter((b) => !(b[0] === T.IAC && b[1] !== undefined && b[1] >= T.SB && b[1] <= T.DONT));
}

describe('x3270 round-trip conformance', () => {
  const captures = existsSync(refDir)
    ? readdirSync(refDir).filter((f) => f.endsWith('.trace'))
    : [];

  if (captures.length === 0) {
    it.skip('needs an x3270 reference capture in packages/fixtures/x3270/', () => {});
    return;
  }

  for (const capture of captures) {
    it(`sends byte-identical inbound records for ${capture}`, () => {
      const text = readFileSync(join(refDir, capture), 'utf8');
      const ours = ourReplies(text);
      const theirs = theirReplies(text);
      expect(ours.length).toBe(theirs.length);
      for (let i = 0; i < theirs.length; i++) {
        expect(ours[i], `record ${i} differs`).toEqual(theirs[i]);
      }
    });
  }
});
