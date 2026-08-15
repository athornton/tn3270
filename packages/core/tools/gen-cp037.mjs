/**
 * Regenerates src/codepages/cp037.ts from Python's built-in cp037 codec.
 * Run: node tools/gen-cp037.mjs > src/codepages/cp037.ts
 *
 * Python's codec is the authority here; hand-transcribing 256 values invites
 * silent errors. Requires python3 on PATH.
 */
import { execFileSync } from 'node:child_process';

const json = execFileSync('python3', [
  '-c',
  'import json;print(json.dumps([bytes([i]).decode("cp037") for i in range(256)]))',
], { encoding: 'utf8' });

const chars = JSON.parse(json);
const codepoints = chars.map((c) => c.codePointAt(0));

const rows = [];
for (let i = 0; i < 256; i += 8) {
  rows.push('  ' + codepoints.slice(i, i + 8).map((n) => `0x${n.toString(16).padStart(4, '0')}`).join(', ') + ',');
}

process.stdout.write(`/**
 * CP037 (EBCDIC US/Canada) to Unicode.
 *
 * GENERATED FILE - do not edit by hand.
 * Regenerate with: node tools/gen-cp037.mjs > src/codepages/cp037.ts
 */

/** EBCDIC byte -> Unicode code point. */
export const CP037_TO_UNICODE: readonly number[] = [
${rows.join('\n')}
];
`);
