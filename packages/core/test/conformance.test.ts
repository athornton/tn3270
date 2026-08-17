import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTrace } from '../src/trace.js';
import { parseX3270Trace } from '../src/x3270trace.js';
import { TelnetLayer } from '../src/telnet.js';
import { Session } from '../src/session.js';
import { TelnetCmd as T } from '../src/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const refDir = join(here, '..', '..', 'fixtures', 'x3270');

/**
 * Compare our inbound bytes against x3270's, for the records a replay CAN check.
 *
 * SCOPE — read this before extending the test. Replaying a capture reproduces
 * only the replies that are a pure function of received bytes: answers to
 * host-initiated Read Buffer / Read Modified commands. It cannot reproduce
 * operator keystrokes, because those come from a human or a script, not from the
 * host. In a real VM/370 capture the inbound traffic was four records, ALL of
 * them keystrokes (`7d` Enter, `6d` Clear) — so a replay-only comparison
 * legitimately finds nothing to check there.
 *
 * The keystroke half is verified by driving both clients through one script
 * against a live host and diffing the traces. That needs a host, so it is not a
 * unit test; see docs/live-testing.md.
 *
 * This test therefore asserts a narrower claim than "byte-identical inbound
 * records": for every host-initiated read in the capture, our reply matches
 * x3270's. That is a real claim, and it is checkable offline.
 */

/** Read a capture in either x3270's native format or ours. */
function readCapture(text: string) {
  const looksLikeX3270 = /^[<>]\s+0x[0-9a-fA-F]+\s+[0-9a-fA-F]+\s*$/m.test(text);
  return looksLikeX3270 ? parseX3270Trace(text) : parseTrace(text);
}

const isNegotiation = (b: readonly number[]): boolean =>
  b[0] === T.IAC && b[1] !== undefined && b[1] >= T.SB && b[1] <= T.DONT;

/**
 * Reframe an event stream into 3270 records.
 *
 * An x3270 event is one socket read and may hold several records or part of one
 * (verified: a 966-byte read containing two IAC EORs), so the bytes must go
 * through a real framer.
 */
function recordsFrom(events: ReturnType<typeof readCapture>, dir: 'recv' | 'send'): number[][] {
  const records: number[][] = [];
  const layer = new TelnetLayer({
    write: () => { /* nothing to transmit while reframing */ },
    onRecord: (r) => records.push(Array.from(r)),
  });
  // The framer only accumulates once 3270 mode is negotiated, so feed everything
  // in order — the capture contains its own negotiation.
  for (const ev of events) {
    if (ev.dir === dir) layer.receive(ev.bytes);
  }
  return records;
}

/** Our replies to the host reads in a capture, in order. */
async function ourReplies(events: ReturnType<typeof readCapture>): Promise<number[][]> {
  const replies: number[][] = [];
  const conn = {
    write: (b: Uint8Array) => {
      const bytes = Array.from(b);
      if (!isNegotiation(bytes)) replies.push(bytes);
    },
    close: () => {},
    onData: undefined as ((b: Uint8Array) => void) | undefined,
    onClose: undefined as (() => void) | undefined,
    onError: undefined as ((e: Error) => void) | undefined,
  };
  const session = new Session({ connect: () => conn });
  // MUST await: connect() assigns conn.onData only after awaiting the factory.
  await session.connect('replay', 0);
  for (const ev of events) {
    if (ev.dir === 'recv') conn.onData?.(ev.bytes);
  }
  return replies;
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
    const events = readCapture(readFileSync(join(refDir, capture), 'utf8'));

    it(`parses ${capture} into well-formed records`, () => {
      // A capture that does not reframe cleanly cannot support any comparison, so
      // check that before comparing anything.
      const hostRecords = recordsFrom(events, 'recv');
      expect(hostRecords.length).toBeGreaterThan(0);
      for (const r of hostRecords) {
        // No record may begin with IAC: that means a framing error, i.e. two
        // records were merged or one was split.
        expect(r[0]).not.toBe(T.IAC);
      }
    });

    it(`replies to every host-initiated read in ${capture} as x3270 did`, async () => {
      const ours = await ourReplies(events);
      const theirs = recordsFrom(events, 'send').filter((b) => !isNegotiation(b));

      // Keystroke-generated records cannot be reproduced by replay (see the note
      // at the top of this file). Ours therefore contains only read answers.
      for (let i = 0; i < ours.length; i++) {
        expect(theirs, `we sent a record x3270 never did: ${ours[i]!.join(' ')}`)
          .toContainEqual(ours[i]);
      }
    });
  }
});
