/**
 * Shared fixture helpers: replay a committed trace, and count the deferred
 * orders inside one.
 *
 * Extracted from `golden.test.ts` so `render.test.ts` can use the SAME replay
 * path rather than growing a second trace parser. There is exactly one trace
 * parser in this project (`core/src/trace.ts`), and a test-local reimplementation
 * of it would be able to diverge from the one the product uses — which is the
 * failure this file exists to prevent.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from '../../src/session.js';
import { parseRecord } from '../../src/stream/parse.js';
import { Order } from '../../src/constants.js';

const here = dirname(fileURLToPath(import.meta.url));

/** `packages/fixtures`. */
export const fixturesDir = join(here, '..', '..', '..', 'fixtures');
/** `packages/fixtures/traces` — the replayable, canonical-format traces. */
export const tracesDir = join(fixturesDir, 'traces');
/** `packages/fixtures/screens` — the golden renderings. */
export const screensDir = join(fixturesDir, 'screens');

/**
 * Replay a fixture from `packages/fixtures/traces/` and return the Session.
 *
 * The `connect` that throws is load-bearing: replay must never open a socket, and
 * a fixture that somehow drove one would fail loudly here instead of reaching the
 * network from a unit test.
 */
export function replayFixture(name: string): Session {
  const session = new Session({
    connect: () => { throw new Error('replay must not open a socket'); },
  });
  session.replay(readFileSync(join(tracesDir, name), 'utf8'));
  return session;
}

export interface DeferredOrderCounts {
  /** Set Attribute orders, X'28'. */
  sa: number;
  /** Modify Field orders, X'2C'. */
  mf: number;
  /** Start Field Extended orders, X'29'. Its own token kind, not a deferred one. */
  sfe: number;
  /** SA orders by attribute TYPE byte — 0x42 is foreground, 0x00 is reset. */
  byType: Map<number, number>;
  /** Inbound records reassembled, and how many of those parsed. */
  records: number;
  parsed: number;
}

/**
 * Count SA, MF and SFE orders in a trace AS THE PARSER SEES THEM.
 *
 * PORTED FROM `packages/cli/scripts/count-orders.mjs`, not re-derived, and THE
 * TWO MUST AGREE — the script is the thing a human runs to check a fresh capture,
 * this is the thing CI runs, and a divergence between them would make one of the
 * two silently wrong. If you change the reassembly here, change it there.
 *
 * WHY NOT A GREP, quoting that script's own header: `grep -oE "28 42"` is wrong in
 * both directions. It matches 0x28 0x42 occurring as SBA/RA address bytes or as
 * ordinary payload data, it misses orders split across a `+` continuation line, and
 * it silently hides SA type 0x00 (reset-to-default) unless you happen to grep for
 * that too — the case that matters most for attribute state. Reassembling records
 * and walking parseRecord's tokens is the only count worth quoting.
 *
 * The one difference from the script is the line regex: the script reads the raw
 * `data: `-prefixed capture (its prefix is optional), this reads the canonical form
 * only. Both accept the same three markers with the same meanings.
 *
 * THAT NARROWNESS IS DELIBERATE — DO NOT "FIX" IT BY MAKING THE PREFIX OPTIONAL
 * HERE. `tracesDir` is the only directory this resolves names under, so a
 * raw-form file cannot arrive in normal use; and on a raw-form file this returns
 * all zeros, which is exactly what makes the TK5 count tests fail as negative
 * controls if the fixture ever reverts to the unconverted form. Widening the
 * regex would silently turn two of those tests green against a blank screen —
 * the precise failure mode they exist to catch. See render.test.ts's
 * "the live TK5 ISPF fixture" block.
 */
export function countDeferredOrders(name: string): DeferredOrderCounts {
  const txt = readFileSync(join(tracesDir, name), 'utf8');

  // Record reassembly, copied exactly: inbound (host->client) records start with
  // '<'; '+' continues the previous one; '>' is outbound and ENDS any record being
  // accumulated without contributing to it. Only inbound records are collected,
  // because only the host sends orders.
  let cur: number[] | null = null;
  const recs: number[][] = [];
  for (const line of txt.split('\n')) {
    const m = /^[0-9.]+ ([<>+]) ((?:[0-9a-f]{2} ?)+)/.exec(line);
    if (!m) continue;
    const dir = m[1]!;
    const bytes = m[2]!.trim().split(/\s+/).map((h) => Number.parseInt(h, 16));
    if (dir === '<') {
      if (cur) recs.push(cur);
      cur = [...bytes];
    } else if (dir === '+' && cur) {
      cur.push(...bytes);
    } else if (dir === '>') {
      if (cur) recs.push(cur);
      cur = null;
    }
  }
  if (cur) recs.push(cur);

  const byType = new Map<number, number>();
  let sa = 0;
  let mf = 0;
  let sfe = 0;
  let parsed = 0;
  for (const r of recs) {
    let b = r;
    // A record beginning 0xff is telnet negotiation (IAC), not a 3270 record.
    if (b[0] === 0xff) continue;
    // Strip a trailing IAC EOR, which frames the record rather than being in it.
    if (b[b.length - 2] === 0xff && b[b.length - 1] === 0xef) b = b.slice(0, -2);
    let rec;
    try {
      rec = parseRecord(Uint8Array.from(b));
    } catch {
      continue; // not a well-formed record; the fixture has a few
    }
    parsed++;
    for (const t of rec.tokens ?? []) {
      if (t.kind === 'sfe') {
        sfe++;
        continue;
      }
      if (t.kind !== 'deferred') continue;
      if (t.order === Order.SA) {
        sa++;
        const ty = t.data[0]!;
        byType.set(ty, (byType.get(ty) ?? 0) + 1);
      }
      if (t.order === Order.MF) mf++;
    }
  }

  return { sa, mf, sfe, byType, records: recs.length, parsed };
}
