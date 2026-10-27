import { Session } from '@tn3270/core';
import { tcpConnect, DEFAULT_TLS, type TlsOptions } from './tls.js';

/**
 * A session whose socket is TLS unless told otherwise.
 *
 * `tls` defaults to `DEFAULT_TLS` — verified TLS — because that is the product
 * default, and a default argument that meant plaintext would make every caller
 * that forgot the parameter silently insecure. `-insecure` passes
 * `{ kind: 'plaintext' }` explicitly.
 */
export function defaultSession(
  terminalType?: string,
  tls: TlsOptions = DEFAULT_TLS,
  /**
   * The model's ALTERNATE screen size, from `resolveAlternateSize`. Absent leaves
   * the session a model 2, where the alternate size equals the default 24x80.
   */
  alternate?: { readonly rows: number; readonly cols: number },
  /**
   * Offer TN3270E. Absent means the product default, which is ON -- matching x3270,
   * and safe because the negotiation backs off to traditional tn3270 on a reject.
   */
  tn3270e?: boolean,
  /**
   * Request the BIND-IMAGE function. Absent means the product default, ON.
   * `-bind-image off` (Task 11) passes `false`.
   */
  bindImage?: boolean,
  /**
   * Range-check a BIND's geometry against the model. Absent means the product
   * default, ON, matching x3270's `bind_limit`. `-bind-limit off` (Task 11) passes
   * `false`.
   */
  bindLimit?: boolean,
  /**
   * Device-name template for NEW-ENVIRON's DEVNAME uservar. Absent means the session
   * refuses telnet option 39 entirely -- see `SessionOptions.devname`. `-devname`
   * (Task 7) passes the template string.
   */
  devname?: string,
  /**
   * Advertise Query Reply (DDM), which lets a host choose DFT file transfer.
   *
   * **ABSENT MEANS ON.** This said "the product default, which is OFF" until 2026-10-27, and
   * that had been false since the default flipped on 2026-09-29. `Session` decides it with
   * `this.opts.ddm !== false` in TWO places that must agree -- the capabilities build
   * (`core/src/session.ts`, the Query Reply) and the `ddmAdvertised` getter a front end uses to
   * tell the operator "DDM was not advertised" -- so `undefined` advertises and only an explicit
   * `-ddm off` suppresses it.
   *
   * THE STALE VERSION COST REAL DIAGNOSIS TIME: a live TSO transfer stalled at 0 bytes, and this
   * comment was read as evidence that DDM had not been offered, which would have made the host's
   * fallback to CUT the explanation. The wire said otherwise. A default's polarity is exactly the
   * kind of claim that outlives its flip, because nothing executes a comment.
   */
  ddm?: boolean,
): Session {
  return new Session({
    connect: (h, p) => tcpConnect(h, p, tls),
    ...(terminalType ? { terminalType } : {}),
    ...(tn3270e === undefined ? {} : { tn3270e }),
    ...(alternate !== undefined
      ? { alternateRows: alternate.rows, alternateCols: alternate.cols }
      : {}),
    ...(bindImage === undefined ? {} : { bindImage }),
    ...(bindLimit === undefined ? {} : { bindLimit }),
    ...(devname === undefined ? {} : { devname }),
    ...(ddm === undefined ? {} : { ddm }),
  });
}
