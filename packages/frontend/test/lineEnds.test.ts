import { describe, it, expect } from 'vitest';
import {
  convertsLineEnds, fromHost, toHost, withLineEnds, transferCommand,
  type TransferFiles, type TransferRequest,
} from '../src/index.js';

const req = (mode: 'ascii' | 'binary', cr: 'auto' | 'remove' | 'add' | 'keep'): TransferRequest => ({
  direction: 'receive', localFile: '/l', hostFile: 'A B A', host: 'vm', mode, cr, exist: 'replace',
});
const b = (...xs: number[]) => Uint8Array.from(xs);

describe('convertsLineEnds: x3270 cr_flag (Common/ft.c:322, :941-951)', () => {
  it('converts in ascii mode for auto, remove and add -- the names are not directional', () => {
    for (const cr of ['auto', 'remove', 'add'] as const) expect(convertsLineEnds(req('ascii', cr)), cr).toBe(true);
  });
  it('never converts for keep, nor in binary mode', () => {
    expect(convertsLineEnds(req('ascii', 'keep'))).toBe(false);
    for (const cr of ['auto', 'remove', 'add', 'keep'] as const) expect(convertsLineEnds(req('binary', cr)), cr).toBe(false);
  });
  it('is exactly when the IND$FILE command carries CRLF, for both hosts and directions', () => {
    // The command's CRLF and the local conversion are ONE rule: a command that asks the host for
    // CRLF with no local conversion was the bug this module fixes.
    //
    // Departure from the plan's literal test: `parseTransferKeywords` requires every argument as
    // `keyword=value` (transfer.ts:446-451); a bare `direction` token throws
    // "needs a value, as keyword=value". Fixed to `direction=${direction}`.
    for (const host of ['vm', 'tso'] as const) for (const direction of ['send', 'receive'] as const)
      for (const mode of ['ascii', 'binary'] as const) for (const cr of ['auto', 'remove', 'add', 'keep'] as const) {
        if (mode === 'binary' && cr !== 'auto') continue; // the parser refuses Cr= without ascii
        const args = [`direction=${direction}`, 'localfile=/l', host === 'vm' ? 'hostfile=A B A' : 'hostfile=A.B', `host=${host}`, `mode=${mode}`, `cr=${cr}`];
        const { request, command } = transferCommand(args);
        expect(/\bCRLF\b/.test(command), args.join(' ')).toBe(convertsLineEnds(request));
      }
  });
});

describe('fromHost: drop every CR and ^Z, wherever (ft_cut.c:190, ft_dft.c:301)', () => {
  it('turns CRLF line ends into LF and drops a trailing ^Z', () => {
    expect([...fromHost(b(0x41, 0x42, 0x0d, 0x0a, 0x43, 0x44, 0x0d, 0x0a, 0x1a))]).toEqual([0x41, 0x42, 0x0a, 0x43, 0x44, 0x0a]);
  });
  it('drops a CR or ^Z in mid-line too, as x3270 does, and a lone trailing CR', () => {
    expect([...fromHost(b(0x41, 0x0d, 0x42, 0x1a, 0x43, 0x0d))]).toEqual([0x41, 0x42, 0x43]);
  });
  it('leaves everything else, and empty input, alone', () => {
    expect([...fromHost(b(0x41, 0x0a, 0x09, 0x7f))]).toEqual([0x41, 0x0a, 0x09, 0x7f]);
    expect([...fromHost(b())]).toEqual([]);
  });
});

describe('toHost: CR before each LF not already after a CR (ft_cut.c:729, ft_dft.c:503)', () => {
  it('turns LF line ends into CRLF', () => {
    expect([...toHost(b(0x41, 0x0a, 0x42, 0x0a))]).toEqual([0x41, 0x0d, 0x0a, 0x42, 0x0d, 0x0a]);
  });
  it('does not double an existing CRLF, and handles a leading LF and LF LF', () => {
    expect([...toHost(b(0x41, 0x0d, 0x0a))]).toEqual([0x41, 0x0d, 0x0a]);
    expect([...toHost(b(0x0a, 0x0a))]).toEqual([0x0d, 0x0a, 0x0d, 0x0a]);
  });
  it('leaves a lone CR, other bytes and empty input alone', () => {
    expect([...toHost(b(0x41, 0x0d, 0x42))]).toEqual([0x41, 0x0d, 0x42]);
    expect([...toHost(b())]).toEqual([]);
  });
});

describe('withLineEnds: the TransferFiles every engine reads and writes through', () => {
  const fake = () => {
    const m = new Map<string, Uint8Array>([['/src', b(0x41, 0x0a)]]);
    const files: TransferFiles = {
      exists: (p) => m.has(p), read: (p) => m.get(p)!,
      write: (p, x) => { m.set(p, x); },
      append: (p, x) => { const o = m.get(p) ?? b(); const n = new Uint8Array(o.length + x.length); n.set(o); n.set(x, o.length); m.set(p, n); },
    };
    return { m, files: withLineEnds(files) };
  };
  it('read applies toHost; write and append apply fromHost; exists passes through', () => {
    const { m, files } = fake();
    expect([...files.read('/src')]).toEqual([0x41, 0x0d, 0x0a]);
    files.write('/dst', b(0x42, 0x0d, 0x0a, 0x1a));
    expect([...m.get('/dst')!]).toEqual([0x42, 0x0a]);
    files.append('/dst', b(0x43, 0x0d, 0x0a));
    expect([...m.get('/dst')!]).toEqual([0x42, 0x0a, 0x43, 0x0a]);
    expect(files.exists('/dst')).toBe(true);
    expect(files.exists('/nope')).toBe(false);
  });
});
