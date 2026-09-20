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
  });
}
