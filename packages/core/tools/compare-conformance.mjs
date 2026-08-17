/**
 * Diff our inbound 3270 records against x3270's, from two live runs.
 *
 * Usage: node tools/compare-conformance.mjs <our-cli-log> <x3270-trace>
 *
 * This is the LIVE half of conformance testing. The unit test
 * (packages/core/test/conformance.test.ts) can only check replies that are a
 * function of received bytes — answers to host-initiated reads. Records generated
 * by operator keystrokes (Enter, Clear, PF keys) come from running a script, so
 * comparing them means actually running both clients against a host. Hence a
 * tool rather than a test.
 *
 * Both inputs must come from driving the paired scripts in packages/cli/scripts:
 * conformance-vm.txt for ours, conformance-vm.s3270 for x3270. Comparing runs of
 * different command lists compares nothing.
 *
 * Telnet negotiation is excluded: option order legitimately varies between
 * clients, and s3270 always advertises TN3270E (`-E` suffix) with no flag to
 * suppress it, so the terminal-type strings differ by design. The 3270 datastream
 * is what stage 1 claims to implement, and that is what this compares.
 */
import { readFileSync } from 'node:fs';
import { parseTrace } from '../dist/trace.js';
import { parseX3270Trace } from '../dist/x3270trace.js';
import { TelnetLayer } from '../dist/telnet.js';
import { TelnetCmd as T } from '../dist/constants.js';

const [ourLog, refTrace] = process.argv.slice(2);
if (!ourLog || !refTrace) {
  process.stderr.write('usage: compare-conformance.mjs <our-cli-log> <x3270-trace>\n');
  process.exit(2);
}

const isNegotiation = (b) =>
  b[0] === T.IAC && b[1] !== undefined && b[1] >= T.SB && b[1] <= T.DONT;

/** Reframe socket reads into 3270 records — one read may hold several. */
function records(events, dir) {
  const out = [];
  const layer = new TelnetLayer({
    write: () => {},
    onRecord: (r) => out.push(Array.from(r)),
  });
  for (const ev of events) if (ev.dir === dir) layer.receive(ev.bytes);
  return out.filter((r) => !isNegotiation(r));
}

/** Our CLI log carries trace lines behind a `data: ` prefix. */
function ourEvents(path) {
  const lines = readFileSync(path, 'utf8').split('\n')
    .filter((l) => /^data: [0-9]+\.[0-9]{3} [<>+=]/.test(l))
    .map((l) => l.slice(6));
  return parseTrace(lines.join('\n'));
}

const ours = records(ourEvents(ourLog), 'send');
const theirs = records(parseX3270Trace(readFileSync(refTrace, 'utf8')), 'send');

const hex = (b) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
let same = 0;
const total = Math.max(ours.length, theirs.length);

process.stdout.write(`x3270: ${theirs.length} records   ours: ${ours.length} records\n\n`);
for (let i = 0; i < total; i++) {
  const a = theirs[i];
  const b = ours[i];
  if (a && b && hex(a) === hex(b)) {
    same++;
    process.stdout.write(`record ${i}: SAME  ${hex(a)}\n`);
  } else {
    process.stdout.write(`record ${i}: DIFF\n  x3270: ${a ? hex(a) : '(none)'}\n  ours : ${b ? hex(b) : '(none)'}\n`);
  }
}
process.stdout.write(`\n${same}/${total} byte-identical\n`);

if (theirs.length === 0) {
  process.stdout.write(
    '\nWARNING: x3270 sent no inbound records. Its run probably failed — check that\n' +
    'the account was not already logged on, and that its Wait() calls returned.\n' +
    'A comparison against zero records proves nothing.\n');
  process.exit(1);
}
process.exit(same === total ? 0 : 1);
