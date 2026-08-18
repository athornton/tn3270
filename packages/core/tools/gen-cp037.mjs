/**
 * Regenerates src/codepages/cp037.ts from Python's built-in cp037 codec.
 * Run: node tools/gen-cp037.mjs src/codepages/cp037.ts
 *
 * Python's codec is the authority here; hand-transcribing 256 values invites
 * silent errors. Requires python3 on PATH.
 *
 * Writes only after the generated table is validated, so a missing python3
 * or a malformed codec response cannot truncate/corrupt an existing,
 * checked-in table. (A naive `node gen.mjs > file.ts` redirect would
 * truncate the target before node even runs.)
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const outPath = process.argv[2];
if (!outPath) {
  console.error('usage: node tools/gen-cp037.mjs <output-path>');
  process.exit(1);
}

const json = execFileSync('python3', [
  '-c',
  'import json;print(json.dumps([bytes([i]).decode("cp037") for i in range(256)]))',
], { encoding: 'utf8' });

const chars = JSON.parse(json);

if (chars.length !== 256) {
  throw new Error(`expected 256 entries from python3 cp037 codec, got ${chars.length}`);
}

const codepoints = chars.map((c, i) => {
  if (typeof c !== 'string' || Array.from(c).length !== 1) {
    throw new Error(`byte 0x${i.toString(16).padStart(2, '0')} decoded to ${JSON.stringify(c)}, expected a single code point`);
  }
  return c.codePointAt(0);
});

const rows = [];
for (let i = 0; i < 256; i += 8) {
  rows.push('  ' + codepoints.slice(i, i + 8).map((n) => `0x${n.toString(16).padStart(4, '0')}`).join(', ') + ',');
}

const output = `/**
 * CP037 (EBCDIC US/Canada) to Unicode.
 *
 * GENERATED FILE - do not edit by hand.
 * Regenerate with: node tools/gen-cp037.mjs src/codepages/cp037.ts
 */

/** EBCDIC byte -> Unicode code point. */
export const CP037_TO_UNICODE: readonly number[] = [
${rows.join('\n')}
];
`;

writeFileSync(outPath, output);
