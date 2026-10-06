/**
 * Chunking and reassembly for socket-carried transfer bytes.
 *
 * ## WHY THE BYTES ARE CHUNKED AT ALL
 *
 * `wsserver.ts:19` caps an inbound message at `MAX_MESSAGE_BYTES` = 8192 and an oversize frame
 * CLOSES THE SOCKET with no message (`:106`, `:114`). That cap is not arbitrary: one process
 * serves up to 16 sessions (`args.ts:132`) and a large synchronous `type` would stall every
 * other operator's session. So a 10 MB upload cannot be one message, AND THE CAP MUST NOT BE
 * RAISED GLOBALLY -- doing so would re-open the exhaustion it exists to refuse, for all 16
 * sessions at once.
 *
 * ## THIS IS TRANSPORT ONLY, NOT A STREAMING ENGINE
 *
 * The reassembled buffer is handed to `startTransfer` whole. `CutTransfer` holds its source up
 * front SO IT CAN ANSWER A RETRANSMIT (`core/src/ft/transfer.ts:220`, `:226`), so a genuinely
 * streaming upload would have to buffer anyway. Streaming the DOWNLOAD direction is a separate,
 * easier job and is deliberately deferred -- see the spec's *Streaming the download*.
 */

/**
 * Source bytes per chunk.
 *
 * 4096 and not 8192: base64 expands 3 bytes to 4, so 4096 source bytes encode to 5464, which
 * leaves ~2.7 KB for the JSON envelope under the 8192 frame cap. Choosing a number that only
 * fits BEFORE encoding is the mistake this constant exists to avoid.
 */
export const CHUNK_BYTES = 4096;

/** Decision 1: 10 MB, and the number is exact so the refusal message can quote it. */
export const MAX_TRANSFER_BYTES = 10 * 1024 * 1024;

/**
 * Split a buffer into wire-sized chunks. An empty source yields no chunks.
 *
 * ## THESE ARE VIEWS, NOT COPIES, AND THAT IS DELIBERATE
 *
 * `subarray` aliases the caller's buffer. The mirror-image decision is recorded at
 * `core/src/ft/dft.ts:267`, which uses `Uint8Array.from(data)` to COPY *because* its source is a
 * view into the inbound record's buffer that the next read overwrites in place -- aliasing there
 * would corrupt every chunk but the last.
 *
 * THE HAZARD DOES NOT APPLY HERE, and the difference is the source's lifetime rather than a
 * preference. The intended caller holds a `File.arrayBuffer()` result: freshly allocated, not
 * pooled, with no second writer, and each chunk is base64-encoded synchronously at send time. So
 * there is no window in which the backing bytes could change, and copying would double the peak
 * memory of the one thing the 10 MB cap exists to bound.
 *
 * SO THE RULE FOR CALLERS IS: do not pass a buffer you are about to reuse. That is also true of
 * `ChunkReassembler.accept`, which retains what it is handed -- see its own note.
 */
export function chunkBytes(src: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < src.length; at += CHUNK_BYTES) {
    out.push(src.subarray(at, Math.min(at + CHUNK_BYTES, src.length)));
  }
  return out;
}

/**
 * A DISCRIMINATED UNION, so `error` narrows to a `string` on the failure arm.
 *
 * `{ ok: boolean; error?: string }` was the first shape and it does not narrow: inside
 * `if (!res.ok)` the message a caller just branched on is still `string | undefined`, forcing a
 * non-null assertion at every use. `handshake.ts` and `frontend`'s `transfer.ts` both use unions
 * for exactly this reason, so this now matches them.
 */
export type AcceptResult =
  | { readonly ok: true; readonly done: boolean }
  | { readonly ok: false; readonly error: string };

/**
 * Reassembles chunks against a total declared up front.
 *
 * STRICT SEQUENCING, AND IT REFUSES RATHER THAN REPAIRS. A gap, a duplicate, an overrun or a
 * chunk after completion is refused with a message the operator sees. It does NOT close the
 * socket: a malformed sequence is an operator-visible refusal, not a protocol violation, and
 * closing would take the whole 3270 session with it.
 *
 * A REFUSAL IS FINAL FOR THIS OBJECT. An earlier version of this comment said a bad chunk
 * "abandons the transfer" while the code abandoned nothing -- the reject paths changed no state,
 * so feeding the right chunk next still completed the transfer. The caller was expected to throw
 * the object away, which is a reasonable contract and was simply not the one written down. Now
 * `failed` enforces it, because a half-rejected reassembler that still completes is a corrupt
 * file delivered as a success.
 *
 * IT RETAINS THE BUFFERS IT IS HANDED, exactly as `chunkBytes` returns views of its source: the
 * bytes passed to `accept` are not copied and are read again by `bytes()`. Today's caller decodes
 * base64 into a fresh buffer per chunk, so nothing can overwrite them. A caller that instead
 * passed a subarray of a reused read accumulator would corrupt every chunk but the last, which
 * is precisely the failure `dft.ts:267` copies to avoid.
 */
export class ChunkReassembler {
  private readonly parts: Uint8Array[] = [];
  private received = 0;
  private next = 0;
  private failed = false;

  constructor(private readonly declared: number) {
    // THE INTEGER CHECK COMES FIRST, and the order is the whole point rather than tidiness.
    // With the cap tested first, `Infinity` and `1e9 + 0.5` both answered "exceeds the
    // 10485760-byte limit" -- telling an operator to try a smaller file when the real fault is a
    // malformed declared total, i.e. a client bug. Decision 2 makes this text operator-facing,
    // so it has to name the actual fault. Measured both cases 2026-10-06.
    if (!Number.isInteger(declared) || declared < 0) {
      throw new Error(`declared total must be a non-negative integer, got ${declared}`);
    }
    if (declared > MAX_TRANSFER_BYTES) {
      // DECISION 2: refused ON PURPOSE and the operator is told so. Both numbers appear, and
      // the attempted size comes FIRST so a truncated line still shows what was attempted.
      throw new Error(
        `transfer of ${declared} bytes exceeds the ${MAX_TRANSFER_BYTES}-byte limit; `
        + 'the gateway stages the whole file in memory, so larger transfers are refused',
      );
    }
  }

  /**
   * Is every declared byte in?
   *
   * TRUE AT CONSTRUCTION FOR A ZERO-BYTE TRANSFER, which is the trap worth naming: `chunkBytes`
   * emits no chunks for an empty file, so `accept` is never called and a caller waiting for
   * `done` from `accept` would wait forever. Ask this, not the last `accept`.
   */
  complete(): boolean {
    return !this.failed && this.received === this.declared;
  }

  accept(seq: number, bytes: Uint8Array): AcceptResult {
    if (this.failed) {
      return { ok: false, error: 'this transfer was already abandoned by an earlier bad chunk' };
    }
    if (this.received === this.declared) {
      // Refused rather than waved through: `chunkBytes` never emits an empty chunk, so an honest
      // client cannot reach this, and silently accepting more after the declared total is in
      // would mean the sender and this object disagree about what file was transferred.
      this.failed = true;
      return { ok: false, error: `chunk ${seq} arrived after all ${this.declared} bytes` };
    }
    if (seq !== this.next) {
      this.failed = true;
      return { ok: false, error: `chunk ${seq} arrived out of sequence, expected ${this.next}` };
    }
    if (this.received + bytes.length > this.declared) {
      this.failed = true;
      return {
        ok: false,
        error: `chunk ${seq} exceeds declared total: `
          + `${this.received + bytes.length} > ${this.declared}`,
      };
    }
    this.parts.push(bytes);
    this.received += bytes.length;
    this.next += 1;
    return { ok: true, done: this.received === this.declared };
  }

  /** The joined bytes, or undefined while incomplete or after a refusal. */
  bytes(): Uint8Array | undefined {
    if (!this.complete()) return undefined;
    const out = new Uint8Array(this.declared);
    let at = 0;
    for (const p of this.parts) { out.set(p, at); at += p.length; }
    return out;
  }
}
