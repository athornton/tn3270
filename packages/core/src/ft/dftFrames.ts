/**
 * DFT (Distributed Function Terminal) file-transfer wire constants.
 *
 * Every value is transcribed from x3270's `include/ft_dft_ds.h`, which is the
 * only place they are written down — the IBM manual documents the DDM Query
 * Reply that ENABLES this protocol but not these request codes.
 *
 * ## THE OFFSET TRAP, AND ITS ONE EXCEPTION
 *
 * x3270 overlays `struct data_buffer` on the START of the structured field, so
 * its offsets count the two length bytes and the SFID. `parseStructuredFields`
 * hands us the parameters only, so **offsets read through `data_bufr` are x3270's
 * minus 3** — the request type, and everything in a `Data Insert`. Confirmed
 * against a live host: TK5 sent field lengths 0x29 and 0x23 and our parser
 * reported 38- and 32-byte payloads (41-3, 35-3).
 *
 * **THE `Open` IS THE EXCEPTION AND ITS OFFSETS ARE UNCHANGED.**
 * `dft_open_request` is handed `cp`, not the struct base, and `cp` already points
 * at struct offset 3 — the same byte our payload starts at. **This file got that
 * wrong first time and its tests passed anyway**, because the test helper wrote
 * the name at the same wrong offset the parser read. Full derivation and the
 * measurement at `NAME_AT_SHORT` below; do not re-apply the -3 here.
 */

import { AID, Sfid } from '../constants.js';

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

/**
 * ## THE OPEN OFFSETS ARE *NOT* x3270's MINUS 3 — THIS IS THE ONE EXCEPTION
 *
 * **CORRECTED 2026-09-25 after empirical measurement; the first version of this
 * file was WRONG here and its tests passed anyway.** The `-3` rule holds for the
 * payload *length* and for `Data Insert`'s offsets, because those are read through
 * `data_bufr`, which overlays the field from byte 0. It does **not** hold for the
 * `Open`, because `dft_open_request` is not given the struct base.
 *
 * `GET16` does **not** advance its pointer (`include/3270ds.h:341-344` — it reads
 * `*(ptr)` and `*(ptr+1)` and assigns nothing back). So at `ft_dft.c:108` `cp` is
 * set to `data_bufr->sf_request_type` and is *still* pointing there when
 * `:114` calls `dft_open_request(data_length, cp)`. `sf_request_type` is at struct
 * offset **3** (verified by `offsetof`), which is exactly where OUR payload
 * starts.
 *
 * So `cp` and our `payload` point at THE SAME BYTE, and the Open's internal
 * offsets carry over **unchanged**:
 *
 * | field | x3270 | ours |
 * |---|---|---|
 * | name, `len == 0x23` | `cp + 25` (`:147`) | **25** |
 * | record size, `len == 0x29` | `cp + 27` (`:151`) | **27** |
 * | name, `len == 0x29` | `cp + 31` (`:153`) | **31** |
 *
 * Measured, not reasoned: a synthetic `0x23` field with `memcpy(cp + 25, "FT:DATA", 7)`
 * puts the name at field index 28 = payload index 25, and payload index 22 reads
 * zeros. The live-probe evidence (field lengths `0x29`/`0x23` arriving as 38/32-byte
 * payloads) confirms the LENGTH subtraction only, and was wrongly generalised to
 * these offsets.
 *
 * **Why the original error was invisible:** the test helper wrote the name at the
 * same wrong offset the parser read it from, so the pair agreed with each other and
 * not with the wire — and the plan itself warns this failure is quiet, because a
 * wrong name simply is not `FT:MSG`, so a MESSAGE frame silently starts a file
 * transfer. `openPayload` now writes at the x3270 offsets and is checked against a
 * byte-for-byte literal frame.
 */
const NAME_AT_SHORT = 25;
const NAME_AT_LONG = 31;
const RECSZ_AT = 27;

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

  // The name ENDS EXACTLY AT THE PAYLOAD'S LAST BYTE in both forms: 25+7 = 32 and
  // 31+7 = 38, the two lengths checked just above. That exact fit is corroborating
  // evidence for the corrected offsets rather than a coincidence -- x3270's
  // `memcpy(namebuf, name, 7)` consumes the field to its end, which is why the
  // short form's legal length is 0x23 and not more. So this is provably in bounds,
  // and an off-by-one in either direction would run off the end.
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

/**
 * Big-endian 16-bit. **Exported because `ft/dft.ts` needs it in Task 6** — the
 * alternative is a second copy in that file, and two hand-rolled big-endian
 * writers that could disagree is exactly the kind of drift this project has been
 * bitten by. Matches x3270's `SET16` macro (`include/3270ds.h:337-340`).
 *
 * Deliberately NOT shared with `queryreply.ts`'s module-private `u16`: that one
 * range-checks and throws, because a Query Reply builds a self-describing
 * structure where a bad length corrupts the whole unit. These writers are called
 * with our own constants and a record counter we increment ourselves, so a shared
 * helper would couple two unrelated wire modules to buy nothing.
 */
export function u16(n: number): [number, number] {
  return [(n >> 8) & 0xff, n & 0xff];
}

/**
 * Big-endian 32-bit, for the record number. Exported for the same reason as
 * `u16`; matches `SET32` (`include/3270ds.h:345-350`).
 *
 * `>>>` is used for the high byte, but note it is NOT load-bearing: `& 0xff`
 * truncates a sign-extended result to the same byte, measured across
 * `0x80000000` and `0xffffffff`. It is written unsigned because that is what the
 * value IS, not because `>>` would produce different bytes here.
 */
export function u32(n: number): [number, number, number, number] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/**
 * Every reply starts `AID_SF, L, L, SF_TRANSFER_DATA`, where L is the structured
 * field length COUNTING ITSELF AND THE SFID BUT NOT THE AID — x3270 writes
 * `SET16(obptr, 5)` before a 6-byte buffer (`ft_dft.c:184`, `space3270out(6)` at
 * `:184`).
 *
 * So `length` here is `body.length + 3`: two length bytes, one SFID, and the
 * caller's body. The AID is outside the count. This is the same +3 relationship
 * as `X3270_HEADER_LEN` on the INBOUND side, and it is the same three bytes — but
 * it is written as its own arithmetic here rather than reusing that constant,
 * because one is "what the parser stripped from a field we received" and the other
 * is "what we must count when declaring a field we send". Tying them together
 * would make a future change to either silently change the other.
 */
function reply(...body: number[]): Uint8Array {
  return Uint8Array.of(AID.SF, ...u16(body.length + 3), Sfid.TRANSFER_DATA, ...body);
}

/**
 * Acknowledge an `Open`. `ft_dft.c:181-189`.
 *
 * Sent for BOTH an `FT:DATA` open and an `FT:MSG` open: x3270 acknowledges before
 * it looks at `message_flag` (`:171-176` precedes `:181`), so the message branch
 * gets the same 6 bytes.
 */
export function buildOpenAck(): Uint8Array {
  // The literal 0x0009 is x3270's, and it is NOT one of the TR_ constants -- it
  // has no name in ft_dft_ds.h. Left as a number with this note rather than
  // given an invented name.
  return reply(...u16(0x0009));
}

/** Acknowledge a `Close`. `ft_dft.c:680-687`. */
export function buildCloseAck(): Uint8Array {
  return reply(...u16(DftReply.CLOSE));
}

/**
 * Acknowledge received data, carrying the record number. `ft_dft.c:206-214`.
 *
 * The counter is the CALLER's: x3270 keeps `recnum` static and increments it here,
 * but a builder that owned it could not construct two acks for the same record,
 * which is what a retransmit needs. Task 5's state machine holds it.
 */
export function buildDataAck(recordNumber: number): Uint8Array {
  return reply(...u16(DftReply.NORMAL), ...u16(DftHeader.RECNUM), ...u32(recordNumber));
}

/**
 * Report a failure. `ft_dft.c:698-706`.
 *
 * `failedRequest` supplies the high byte of the reply type, which is why
 * `DftReply.ERROR` is 8 bits: x3270 writes `HIGH8(code)` then the error byte, so
 * a failed GET (`0x4611`) yields reply type `0x4608`. The code sent is always
 * `TR_ERR_CMDFAIL` — every one of `dft_abort`'s five call sites passes a different
 * REQUEST but the same error code (`:155`, `:227`, `:401`, `:577`, `:619`).
 * `TR_ERR_EOF` is used only by the upload's own EOF frame, not here.
 */
export function buildDftError(failedRequest: number): Uint8Array {
  return reply(
    (failedRequest >> 8) & 0xff,
    DftReply.ERROR,
    ...u16(DftHeader.ERROR),
    ...u16(DftError.CMDFAIL),
  );
}
