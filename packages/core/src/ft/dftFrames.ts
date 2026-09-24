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

/** Sub-headers inside a frame. */
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

/** Error codes. */
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
