/**
 * DFT (Distributed Function Terminal) file-transfer wire constants.
 *
 * Every value is transcribed from x3270's `include/ft_dft_ds.h`, which is the
 * only place they are written down — the IBM manual documents the DDM Query
 * Reply that ENABLES this protocol but not these request codes.
 *
 * ## THE OFFSET TRAP
 *
 * x3270 overlays `struct data_buffer` on the START of the structured field, so
 * its offsets count the two length bytes and the SFID. `parseStructuredFields`
 * hands us the parameters only. **Every offset here is x3270's minus 3**, and the
 * constants below are named for OUR frame so the subtraction happens once.
 * Confirmed against a live host: TK5 sent field lengths 0x29 and 0x23 and our
 * parser reported 38- and 32-byte payloads (41-3, 35-3).
 */

/**
 * x3270 overlays its offsets on the RAW structured field; ours start 3 bytes
 * later, because parseStructuredFields has already stripped the two length
 * bytes and the SFID. See "THE OFFSET TRAP" above.
 */
export const X3270_HEADER_LEN = 3;

/** Host request types: `TR_*_REQ` and `TR_DATA_INSERT`. */
export const DftRequest = {
  /** `TR_OPEN_REQ` — open a file or announce a message. */
  OPEN: 0x0012,
  /** `TR_CLOSE_REQ`. */
  CLOSE: 0x4112,
  /**
   * `TR_SET_CUR_REQ` — set cursor. `dft_set_cur_req` (`ft_dft.c:414-419`) only
   * traces; it calls `net_output()` nowhere, so no reply frame goes out at all
   * — not even a bare acknowledgement.
   */
  SET_CUR: 0x4511,
  /** `TR_GET_REQ` — host wants data FROM us: this is the upload path. */
  GET: 0x4611,
  /**
   * `TR_INSERT_REQ`. x3270's handler (`ft_dft.c:193-198`) is the same shape as
   * `SET_CUR`'s: it traces and returns, with no `net_output()` call.
   */
  INSERT: 0x4711,
  /** `TR_DATA_INSERT` — host is giving us data: the download path. */
  DATA_INSERT: 0x4704,
} as const;

/** Replies we send. `TR_*_REPLY`. */
export const DftReply = {
  /** `TR_GET_REPLY` — our data, answering a GET. */
  GET: 0x4605,
  /** `TR_NORMAL_REPLY` — an acknowledgement carrying a record number. */
  NORMAL: 0x4705,
  /**
   * `TR_ERROR_REPLY`, and note it is **8 bits**, not 16: x3270 writes
   * `HIGH8(code)` then this byte, so the reply type's high byte is borrowed from
   * whatever request failed (`ft_dft.c:703-704`, `:645-646`).
   */
  ERROR: 0x08,
  /** `TR_CLOSE_REPLY`. */
  CLOSE: 0x4109,
} as const;

/** Sub-headers inside a frame: `TR_*_HDR`. */
export const DftHeader = {
  /** `TR_RECNUM_HDR`, followed by a 32-bit record number. */
  RECNUM: 0x6306,
  /** `TR_ERROR_HDR`, followed by a 16-bit error code. */
  ERROR: 0x6904,
  /** `TR_NOT_COMPRESSED`. We never compress, so this is the only value we send. */
  NOT_COMPRESSED: 0xc080,
  /** `TR_BEGIN_DATA`, a single byte introducing the length-prefixed payload. */
  BEGIN_DATA: 0x61,
} as const;

/** Error codes: `TR_ERR_*`. */
export const DftError = {
  /** `TR_ERR_EOF` — a GET past end of file. Not a failure: it ends an upload. */
  EOF: 0x2200,
  /** `TR_ERR_CMDFAIL` — what `dft_abort` always sends (`ft_dft.c:706`). */
  CMDFAIL: 0x0100,
} as const;

/**
 * `OPEN_MSG` (`ft_dft.c:53`). An `Open` whose trimmed name equals this is the
 * host announcing a MESSAGE, not a file — x3270 sets `message_flag` and pointedly
 * does NOT call `ft_running`, so it must not start a transfer.
 */
export const OPEN_MSG = 'FT:MSG';

/** A malformed DFT frame. A transfer fault, never a session fault. */
export class DftFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DftFrameError';
  }
}

/** A parsed DFT frame: the request type, and the payload it came from. */
export interface DftFrame {
  /** 16-bit request type from payload offset 0. One of `DftRequest`'s values. */
  requestType: number;
  /**
   * The whole payload, INCLUDING the request type. Handlers read their own
   * fields at their own offsets, so they need the original bytes rather than a
   * subarray whose offsets differ again.
   */
  payload: Uint8Array;
}

/**
 * Extract a `SF_TRANSFER_DATA` payload's request type, without disturbing the
 * payload.
 *
 * `payload` is what `parseStructuredFields` yields: the parameters, with the
 * length bytes and the SFID already removed. So the request type x3270 reads at
 * `cp+3` is at **0** here. See the offset trap in this module's header comment.
 */
export function parseDftFrame(payload: Uint8Array): DftFrame {
  if (payload.length < 2) {
    throw new DftFrameError(
      `DFT frame needs at least 2 bytes for a request type, got ${payload.length}`,
    );
  }
  return { requestType: (payload[0]! << 8) | payload[1]!, payload };
}

/**
 * The two legal `Open` payload lengths, which are x3270's two legal FIELD
 * lengths minus the 3-byte header we never see.
 *
 * `dft_open_request` tests `len == 0x23` and `len == 0x29` on the field length
 * (`ft_dft.c:146-148`). TK5 sent both in one session, arriving here as 32 and 38
 * bytes, which is what confirmed the subtraction against a real host.
 */
const OPEN_SHORT = 0x23 - X3270_HEADER_LEN;   // 32
const OPEN_LONG = 0x29 - X3270_HEADER_LEN;    // 38

/** Name offsets, x3270's +25 / +31 less the header (`ft_dft.c:147,153`). */
const NAME_AT_SHORT = 25 - X3270_HEADER_LEN;  // 22
const NAME_AT_LONG = 31 - X3270_HEADER_LEN;   // 28
/** Record size offset, x3270's +27 less the header (`ft_dft.c:151`). */
const RECSZ_AT = 27 - X3270_HEADER_LEN;       // 24

/** How many bytes the name field occupies. `memcpy(namebuf, name, 7)` (`ft_dft.c:159`). */
const NAME_LENGTH = 7;

/** A parsed `Open`. */
export interface DftOpen {
  /** The 7-byte name with trailing spaces trimmed. */
  name: string;
  /**
   * `true` when the name is `FT:MSG`: the host is sending a MESSAGE, not opening
   * a file. x3270 sets `message_flag` and does not call `ft_running`
   * (`ft_dft.c:171-176`), so this must not start a transfer.
   */
  isMessage: boolean;
  /**
   * Record size, present only in the long form. Absent rather than 0 when the
   * host did not send one, because 0 is what x3270 uses as "no value" and an
   * optional property says so in the type.
   */
  recordSize?: number;
}

/**
 * Parse an `Open` request.
 *
 * The name is compared as ASCII. That looks wrong for a 3270 data stream and is
 * not: x3270 does `strcmp(namebuf, OPEN_MSG)` on the raw bytes with no EBCDIC
 * translation (`ft_dft.c:171`), and TK5's own frames carry ASCII `FT:DATA` —
 * observed in the 2026-09-24 probe trace. The name is metadata the host writes in
 * the PC's alphabet, not screen data.
 */
export function parseDftOpen(payload: Uint8Array): DftOpen {
  let nameAt: number;
  let recordSize: number | undefined;

  if (payload.length === OPEN_SHORT) {
    nameAt = NAME_AT_SHORT;
  } else if (payload.length === OPEN_LONG) {
    nameAt = NAME_AT_LONG;
    recordSize = (payload[RECSZ_AT]! << 8) | payload[RECSZ_AT + 1]!;
  } else {
    throw new DftFrameError(
      `unknown Open length: ${payload.length} payload bytes `
      + `(expected ${OPEN_SHORT} or ${OPEN_LONG}, i.e. field length 0x23 or 0x29)`,
    );
  }

  // `nameAt + i` maxes at 28 (short, < 32) or 34 (long, < 38), both within the
  // length just checked above, so this is provably in bounds -- the same idiom
  // parseDftFrame uses two functions up, not a real bounds concern needing a
  // fallback.
  let name = '';
  for (let i = 0; i < NAME_LENGTH; i++) name += String.fromCharCode(payload[nameAt + i]!);
  // Trailing spaces only, matching x3270's backwards walk from namebuf[6]
  // (ft_dft.c:161-164). trimEnd() would also eat tabs and newlines, which are
  // legal name bytes; a host sending one would silently get a different name.
  name = name.replace(/ +$/, '');

  // `recordSize: undefined` would not typecheck under exactOptionalPropertyTypes
  // against an optional property, so the key is added only when it has a value.
  // Same spread-when-defined idiom as bind.ts:116.
  return { name, isMessage: name === OPEN_MSG, ...(recordSize === undefined ? {} : { recordSize }) };
}
