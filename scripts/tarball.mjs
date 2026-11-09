/**
 * A .tgz reader, for checking what `npm pack` wrote: `pack.mjs` (is there a LICENSE?) and
 * `publish.mjs` (the manifest inside). MOVED HERE FROM `pack.mjs`'s `tarEntries` (2026-11-09) so
 * `publish.mjs` can run without `npm ci` (see `workspaces.mjs`). NOTHING BUT `node:` IMPORTS HERE.
 *
 * ustar: name at 0, size in octal at 124, type at 156, prefix at 345; data follows the header,
 * padded to 512. PAX HEADERS ARE APPLIED, NOT LISTED: an `x` entry's `path`/`size` records
 * override the next entry's own fields (node-tar, hence `npm pack`, writes one for a path longer
 * than ustar holds), a `g` entry's apply to every later entry, and GNU `L` long names are taken
 * the same way. The old `tarEntries` listed an `x` header as if it were a file and missed the long
 * path it carried.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

/** `"<len> key=value\n"` records -> an object. `<len>` is in BYTES and counts the whole record. */
function paxRecords(buf) {
  const out = {};
  for (let o = 0; o < buf.length;) {
    const sp = buf.indexOf(0x20, o);
    if (sp < 0) break;
    const len = parseInt(buf.subarray(o, sp).toString('utf8'), 10);
    if (!(len > 0)) break;
    const rec = buf.subarray(sp + 1, o + len - 1).toString('utf8'); // drop the trailing '\n'
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    o += len;
  }
  return out;
}

/** Every entry in a .tgz, path -> its bytes, in archive order. Metadata entries are not listed. */
export function readTar(tgz) {
  const tar = gunzipSync(readFileSync(tgz));
  const entries = new Map();
  let global = {};
  let next = {};
  for (let o = 0; o + 512 <= tar.length;) {
    const h = tar.subarray(o, o + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const type = String.fromCharCode(h[156]);
    const meta = 'xgLK'.includes(type);
    // A pax `size` describes the next FILE's data, never a metadata entry's own.
    const pax = meta ? {} : { ...global, ...next };
    const size = pax.size !== undefined ? Number(pax.size) : parseInt(field(124, 136).trim() || '0', 8);
    const data = tar.subarray(o + 512, o + 512 + size);
    o += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { next = { ...next, ...paxRecords(data) }; continue; }
    if (type === 'g') { global = { ...global, ...paxRecords(data) }; continue; }
    if (type === 'L') { next = { ...next, path: data.toString('utf8').replace(/\0.*$/s, '') }; continue; }
    if (type === 'K') continue; // GNU long link name: nothing here reads link targets
    const prefix = field(345, 500);
    entries.set(pax.path ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100)), data);
    next = {};
  }
  return entries;
}
