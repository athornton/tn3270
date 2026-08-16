/**
 * Regenerate a golden screen from a trace.
 *
 * Usage: node tools/make-golden.mjs ../fixtures/traces/foo.trace > ../fixtures/screens/foo.txt
 *
 * Review the diff before committing a regenerated golden — that diff IS the
 * behavioral change under review.
 */
import { readFileSync } from 'node:fs';
import { Session } from '../dist/index.js';

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: make-golden.mjs <trace file>\n');
  process.exit(2);
}

const session = new Session({ connect: () => { throw new Error('replay needs no socket'); } });
session.replay(readFileSync(path, 'utf8'));

const lines = session.screen.toText().split('\n');
const out = [];
out.push('# Golden screen. Regenerate with tools/make-golden.mjs; review the diff.');
out.push(`# cursor: ${session.screen.cursor}  oia: ${session.oia.toText()}`);
out.push('+' + '-'.repeat(session.screen.cols) + '+');
for (const l of lines) out.push('|' + l + '|');
out.push('+' + '-'.repeat(session.screen.cols) + '+');
process.stdout.write(out.join('\n') + '\n');
