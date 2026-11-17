/**
 * Ascii line ends in IND$FILE transfers, converted locally exactly as x3270 does.
 *
 * ONE FLAG, AS x3270 HAS: `cr_flag` is true in ascii mode unless `Cr=keep` (Common/ft.c:322,
 * :941-951). THE NAMES ARE NOT DIRECTIONAL: `Cr=remove` on a send also adds CRs, and `Cr=add` on a
 * receive also strips them -- x3270 collapses the three to one boolean, and so does this.
 *
 * The same rule decides whether the IND$FILE command carries `CRLF` (`transfer.ts`, `wantsCrlf`,
 * which calls `convertsLineEnds`): CRLF tells the host the local side uses CRLF line ends, and this
 * module is what turns those into the local LF ones. Before it existed, every front end asked for
 * CRLF and converted nothing, so a received text file kept its CRs and a trailing ^Z.
 */
import type { TransferFiles, TransferRequest } from './transfer.js';

const CR = 0x0d;
const LF = 0x0a;
const SUB = 0x1a; // ^Z

/** Does this transfer convert line ends locally? x3270's `cr_flag`. */
export function convertsLineEnds(request: Pick<TransferRequest, 'mode' | 'cr'>): boolean {
  return request.mode === 'ascii' && request.cr !== 'keep';
}

/** Received bytes with every CR and ^Z removed, wherever they are (ft_cut.c:190, ft_dft.c:301). */
export function fromHost(bytes: Uint8Array): Uint8Array {
  return bytes.filter((c) => c !== CR && c !== SUB);
}

/** Bytes to send, with a CR before each LF that does not already follow one (ft_cut.c:729, ft_dft.c:503). */
export function toHost(bytes: Uint8Array): Uint8Array {
  let extra = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === LF && (i === 0 || bytes[i - 1] !== CR)) extra++;
  if (extra === 0) return bytes;
  const out = new Uint8Array(bytes.length + extra);
  let o = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === LF && (i === 0 || bytes[i - 1] !== CR)) out[o++] = CR;
    out[o++] = bytes[i]!;
  }
  return out;
}

/**
 * `files` with the conversion applied: `read` (a send's source) through `toHost`, `write` and
 * `append` (a receive's result) through `fromHost`. `startTransfer` swaps this in once, so both
 * engines' reads and writes go through it and cannot diverge.
 */
export function withLineEnds(files: TransferFiles): TransferFiles {
  return {
    exists: (path) => files.exists(path),
    read: (path) => toHost(files.read(path)),
    write: (path, bytes) => { files.write(path, fromHost(bytes)); },
    append: (path, bytes) => { files.append(path, fromHost(bytes)); },
  };
}
