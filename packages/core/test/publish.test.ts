import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readTar } from '../../../scripts/tarball.mjs';
import { publishedPackages, tarballName } from '../../../scripts/workspaces.mjs';

/** One 512-byte ustar header for `name` of `size` bytes, of tar `type` ('0' regular, 'x' pax). */
function header(name: string, size: number, type = '0'): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);       // checksum field as spaces while summing
  h.write(type, 156);
  h.write('ustar\0' + '00', 257);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

/** `body` padded out to a whole number of 512-byte blocks. */
function padded(body: Buffer): Buffer[] {
  return [body, Buffer.alloc((512 - (body.length % 512)) % 512)];
}

/** One pax record, `"<len> key=value\n"`, where `<len>` counts the whole record including itself. */
function paxRecord(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(rest) + 1;
  while (String(len).length + Buffer.byteLength(rest) !== len) len++;
  return `${len}${rest}`;
}

/**
 * A minimal ustar archive, gzipped: what `npm pack` writes, for the entries given. An entry whose
 * name is longer than ustar's 100 bytes gets a pax `x` header carrying its `path`, as node-tar
 * (npm pack) writes one.
 */
export function makeTgz(entries: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(entries)) {
    const body = Buffer.from(text);
    if (Buffer.byteLength(name) > 100) {
      const pax = Buffer.from(paxRecord('path', name));
      blocks.push(header('PaxHeader/long', pax.length, 'x'), ...padded(pax));
      blocks.push(header(name.slice(0, 100), body.length), ...padded(body));
    } else {
      blocks.push(header(name, body.length), ...padded(body));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe('readTar', () => {
  it("returns each entry's bytes by path", () => {
    const d = mkdtempSync(join(tmpdir(), 'tar-'));
    try {
      const p = join(d, 'x.tgz');
      writeFileSync(p, makeTgz({ 'package/package.json': '{"name":"@tn3270/core"}', 'package/LICENSE': 'MIT' }));
      const t = readTar(p);
      expect([...t.keys()]).toEqual(['package/package.json', 'package/LICENSE']);
      expect(t.get('package/LICENSE')!.toString()).toBe('MIT');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('takes a long path from its pax header, and lists no pax header as an entry', () => {
    const d = mkdtempSync(join(tmpdir(), 'tar-'));
    try {
      const p = join(d, 'x.tgz');
      const long = `package/dist/${'a'.repeat(120)}.js`;
      writeFileSync(p, makeTgz({ 'package/package.json': '{}', [long]: 'x'.repeat(600), 'package/LICENSE': 'MIT' }));
      const t = readTar(p);
      expect([...t.keys()]).toEqual(['package/package.json', long, 'package/LICENSE']);
      expect(t.get(long)!.toString()).toBe('x'.repeat(600));
      expect(t.get('package/LICENSE')!.toString()).toBe('MIT');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('workspaces', () => {
  it('finds the eight published packages, and names their tarballs as npm pack does', () => {
    const names = publishedPackages().map(({ m }) => m.name).sort();
    expect(names).toEqual(['@tn3270/canvas', '@tn3270/cli', '@tn3270/core', '@tn3270/frontend',
      '@tn3270/gui', '@tn3270/node-files', '@tn3270/tui', '@tn3270/web']);
    expect(tarballName({ name: '@tn3270/node-files', version: '0.1.1' })).toBe('tn3270-node-files-0.1.1.tgz');
  });
});
