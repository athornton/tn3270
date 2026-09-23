/**
 * The `TransferFiles` implementation over `node:fs`.
 *
 * ITS OWN PACKAGE, and deliberately not part of `frontend`, for two reasons that both
 * matter later: the browser bundles (`gui`, `web`) must never acquire a `node:fs` import,
 * and stage 4's web gateway needs a DIFFERENT implementation of this same interface, whose
 * "filesystem" is an upload/download pair rather than a disk. Both front ends that do have
 * a disk (`cli`, `tui`) share this one, so a filesystem bug has exactly one home.
 *
 * Moved here from `cli/src/main.ts`, where it lived for the same reason `Replay(file)`'s
 * I/O does: `runner.ts` stays free of `node:fs` so every command's semantics are testable
 * without a temp directory. It was injected rather than special-cased because a transfer's
 * file access is interleaved with host round trips and cannot be lifted out of the caller
 * the way reading a replay file up front can.
 *
 * `Uint8Array`, never a string: these are file BYTES, and the whole point of the binary
 * default is that nothing in the path decodes them. `readFileSync` with no encoding returns
 * a Buffer, which IS a Uint8Array, but a fresh view is constructed so nothing downstream
 * can be surprised by Buffer's extra methods or by its pooled backing store.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import type { TransferFiles } from '@tn3270/frontend';

export const nodeTransferFiles: TransferFiles = {
  exists: (path) => existsSync(path),
  read: (path) => new Uint8Array(readFileSync(path)),
  write: (path, bytes) => { writeFileSync(path, bytes); },
  append: (path, bytes) => { appendFileSync(path, bytes); },
};
