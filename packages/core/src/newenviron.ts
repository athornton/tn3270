/**
 * The TELNET NEW-ENVIRON option (RFC 1572), telnet option 39.
 *
 * PURE: this module parses a request body and builds a reply body. It holds no session
 * state, opens no socket and owns no counter -- `DeviceName` in devname.ts is where the
 * one piece of state lives, and it is passed in already resolved. Same division as
 * `tn3270e.ts` (a pure state machine) and `bind.ts` (pure parsers).
 *
 * WHAT A HOST USES IT FOR HERE: a `DEVNAME` USERVAR naming the session. That is a
 * SECOND route to the thing TN3270E's CONNECT does with LU names, and the two are
 * unrelated mechanisms for different hosts -- do not unify them.
 *
 * Reference implementation: x3270's Common/telnet_new_environ.c.
 */
import { EnvironGroup } from './constants.js';

/** One requested entry. An empty `name` means "every variable in this group". */
export interface EnvironRequest {
  readonly group: number;
  readonly name: string;
}

/**
 * Parse a SEND request body into the entries requested, in order.
 *
 * Returns null for a malformed body rather than throwing -- the same contract as
 * `decodeHeader` and `parseBind`, and for the same reason: a client cannot correct a
 * host, and an exception here would surface to the operator as a program check the host
 * never caused.
 *
 * THE ORDER IS PRESERVED because the reply must list variables in the order asked; the
 * recorded trace does exactly that with its three uservars.
 *
 * TWO NON-OBVIOUS BEHAVIOURS, both from x3270's four-state machine
 * (telnet_new_environ.c:356-470):
 *  - A VAR or USERVAR byte ENDS the previous request and begins a new one. There is no
 *    length prefix and no delimiter; the group bytes are the delimiters.
 *  - AN EMPTY BODY MEANS "SEND EVERYTHING" and expands to one request per group
 *    (:453-470). Returning an empty list instead would answer such a host with nothing,
 *    in a reply that is still well-formed -- so nothing downstream would notice. This is
 *    not merely x3270's C: a REAL HOST DOES THIS. `s3270/Test/dbcs-wrap.trc:103-104` has
 *    the host send a bare `fffa2701fff0` (SEND, empty body) and x3270's reply at :108
 *    dumps every VAR and USERVAR it knows (`lu.trc`, `target.trc` and `korean.trc` show
 *    the same pattern). A recorded host, not just the reference source, depends on the
 *    empty-body expansion.
 *
 * ON x3270's FOUR STATES VERSUS THIS FUNCTION'S TWO (`out.length === 0` doubling as
 * `EE_BASE`, "append to `out[out.length-1]!.name`" doubling as both `EE_VAR` and
 * `EE_NAME`): checked against the source, `EE_VAR`'s default arm (Malloc(1); name[0]=c)
 * and `EE_NAME`'s default arm (Realloc; name[len-1]=c) build the identical byte
 * sequence, and both route a VAR/USERVAR byte and an ESC byte identically
 * (telnet_new_environ.c:397-440) -- `EE_VAR`'s only difference is that a *plain* byte
 * moves it to `EE_NAME`, which is a self-transition from `EE_NAME`'s own point of view.
 * No input distinguishes them; collapsing the two into "does this request already have
 * a name byte" changes nothing observable.
 *
 * NOT REPLICATED: x3270's `EE_NAME_ESC` case never transitions back to `EE_NAME` after
 * consuming the escaped byte (no `state = EE_NAME;` anywhere in that arm) -- so in the
 * reference parser, ONE escape inside a name permanently disables the VAR/USERVAR
 * delimiter for the rest of the buffer, silently absorbing what should have been the
 * next request's group byte into the current name. That looks like a latent bug in
 * telnet_new_environ.c, not a behaviour worth copying: RFC 1572 defines ESC as escaping
 * exactly the following byte, which is what this function does (`escaped` is cleared
 * right after consuming one literal byte).
 *
 * THIS IS NOT MERELY UNTESTED, IT IS UNREACHABLE: every NEW-ENVIRON SEND in x3270's
 * entire trace collection (`s3270/Test/*.trc`) was grepped for byte 0x02 in a name or
 * value, and none contains one -- every real name on the wire is plain ASCII (`IBMELF`,
 * `IBMAPPLID`, `DEVNAME`, `USER`, `CODEPAGE`, `CHARSET`, `KBDTYPE`). No host anyone has
 * recorded exercises an escape at all, so none can have been built to depend on the
 * sticky `EE_NAME_ESC` state -- this divergence differs from x3270 somewhere no host
 * can reach, not merely somewhere no trace happens to look.
 */
export function parseEnvironSend(body: Uint8Array): readonly EnvironRequest[] | null {
  const out: { group: number; name: number[] }[] = [];
  let escaped = false;

  for (const c of body) {
    if (escaped) {
      // ESC makes the next byte literal, whatever it is.
      out[out.length - 1]!.name.push(c);
      escaped = false;
      continue;
    }
    if (c === EnvironGroup.VAR || c === EnvironGroup.USERVAR) {
      out.push({ group: c, name: [] });
      continue;
    }
    if (out.length === 0) {
      // A name byte before any group byte: x3270's EE_BASE refuses this.
      return null;
    }
    if (c === EnvironGroup.ESC) {
      escaped = true;
      continue;
    }
    out[out.length - 1]!.name.push(c);
  }

  if (out.length === 0) {
    // "Send everything." Both groups, in x3270's order.
    return [
      { group: EnvironGroup.VAR, name: '' },
      { group: EnvironGroup.USERVAR, name: '' },
    ];
  }

  // Spreading `r.name` into `fromCharCode` is fine because the caller can never hand us
  // more bytes than the whole subnegotiation held, and `telnet.ts`'s MAX_SUBNEG_BYTES
  // (1024) caps that upstream before this function ever runs -- so there is no
  // pathologically long name here to blow an engine's argument-count limit.
  return out.map((r) => ({
    group: r.group,
    name: String.fromCharCode(...r.name),
  }));
}
