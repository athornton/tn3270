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

/** Split a buffer into wire-sized chunks. An empty source yields no chunks. */
export function chunkBytes(src: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < src.length; at += CHUNK_BYTES) {
    out.push(src.subarray(at, Math.min(at + CHUNK_BYTES, src.length)));
  }
  return out;
}

export interface AcceptResult {
  readonly ok: boolean;
  /** True once every declared byte has arrived. */
  readonly done?: boolean;
  readonly error?: string;
}

/**
 * Reassembles chunks against a total declared up front.
 *
 * STRICT SEQUENCING, AND IT REFUSES RATHER THAN REPAIRS. A gap, a duplicate or an overrun
 * abandons the transfer with a message the operator sees. It does NOT close the socket: a
 * malformed sequence is an operator-visible refusal, not a protocol violation, and closing
 * would take the whole 3270 session with it.
 */
export class ChunkReassembler {
  private readonly parts: Uint8Array[] = [];
  private received = 0;
  private next = 0;

  constructor(private readonly declared: number) {
    if (declared > MAX_TRANSFER_BYTES) {
      // DECISION 2: refused ON PURPOSE and the operator is told so. Both numbers appear, and
      // the limit comes second so a truncated line still shows what was attempted.
      throw new Error(
        `transfer of ${declared} bytes exceeds the ${MAX_TRANSFER_BYTES}-byte limit; `
        + 'the gateway stages the whole file in memory, so larger transfers are refused',
      );
    }
    if (declared < 0 || !Number.isInteger(declared)) {
      throw new Error(`declared total must be a non-negative integer, got ${declared}`);
    }
  }

  accept(seq: number, bytes: Uint8Array): AcceptResult {
    if (seq !== this.next) {
      return { ok: false, error: `chunk ${seq} arrived out of sequence, expected ${this.next}` };
    }
    if (this.received + bytes.length > this.declared) {
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

  /** The joined bytes, or undefined while incomplete. */
  bytes(): Uint8Array | undefined {
    if (this.received !== this.declared) return undefined;
    const out = new Uint8Array(this.declared);
    let at = 0;
    for (const p of this.parts) { out.set(p, at); at += p.length; }
    return out;
  }
}
