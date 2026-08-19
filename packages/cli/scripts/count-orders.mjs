// Count deferred orders (SA, MF) in a trace, AS THE PARSER SEES THEM.
//
// WHY THIS EXISTS RATHER THAN A GREP. The obvious `grep -oE "28 42"` over a trace is
// wrong in both directions, and it produced a wrong number in a draft of the TUI/colour
// spec: it matches 0x28 0x42 occurring as SBA/RA address bytes or as ordinary payload
// data, and it misses orders split across a `+` continuation line. It also silently
// hides SA type 0x00 (reset-to-default) unless you happen to grep for it, which is the
// case that matters most for attribute state.
//
// Reassembling records and walking parseRecord's tokens is the only count worth quoting.
//
//   node packages/cli/scripts/count-orders.mjs [trace-file]
//
// Defaults to the committed TK5 ISPF fixture, whose expected output is:
//   SA total: 113  MF total: 0
//     SA type 0x42 -> 101      (foreground colour)
//     SA type 0x00 -> 12       (reset character attributes)

import { readFileSync } from 'node:fs';
import { parseRecord } from '../../core/dist/stream/parse.js';

const file = process.argv[2]
  ?? new URL('../../fixtures/mvs/mvs-tk5-tso-ispf.trace', import.meta.url);
const txt = readFileSync(file, 'utf8');

// Inbound (host->client) records start with '<'; '+' continues the previous one; '>' is
// outbound and ends any record being accumulated.
let cur = null;
const recs = [];
for (const line of txt.split('\n')) {
  const m = line.match(/^data: [0-9.]+ ([<>+]) ((?:[0-9a-f]{2} ?)+)/);
  if (!m) continue;
  const [, dir, hex] = m;
  const bytes = hex.trim().split(/\s+/).map((h) => parseInt(h, 16));
  if (dir === '<') {
    if (cur) recs.push(cur);
    cur = { bytes: [...bytes] };
  } else if (dir === '+' && cur) {
    cur.bytes.push(...bytes);
  } else if (dir === '>') {
    if (cur) recs.push(cur);
    cur = null;
  }
}
if (cur) recs.push(cur);

const types = new Map();
let sa = 0;
let mf = 0;
let parsed = 0;
for (const r of recs) {
  let b = r.bytes;
  if (b[0] === 0xff) continue; // telnet negotiation, not a 3270 record
  if (b[b.length - 2] === 0xff && b[b.length - 1] === 0xef) b = b.slice(0, -2); // IAC EOR
  let rec;
  try {
    rec = parseRecord(Uint8Array.from(b));
  } catch {
    continue; // not a well-formed record; the fixture has a few
  }
  parsed++;
  for (const t of rec.tokens ?? []) {
    if (t.kind !== 'deferred') continue;
    if (t.order === 0x28) {
      sa++;
      const ty = t.data[0];
      types.set(ty, (types.get(ty) ?? 0) + 1);
    }
    if (t.order === 0x2c) mf++;
  }
}

console.log('inbound records reassembled:', recs.length, 'parsed:', parsed);
console.log('SA total:', sa, ' MF total:', mf);
for (const [ty, n] of [...types].sort((a, b) => b[1] - a[1])) {
  console.log('  SA type 0x' + ty.toString(16).padStart(2, '0'), '->', n);
}
