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
import { EnvironGroup, EnvironQual } from './constants.js';

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

/**
 * Escape a name or value for the wire (RFC 1572; x3270's `escaped_copy`,
 * telnet_new_environ.c:118-129).
 *
 * Any byte equal to one of the four group codes would otherwise be read as a
 * delimiter, so it is prefixed with ESC. The receiver strips the ESC and takes the next
 * byte literally, which is what `parseEnvironSend` does.
 *
 * UNWITNESSED BY ANY HOST: every real device name in x3270's trace collection is plain
 * ASCII, so no recorded exchange exercises this. Implemented anyway, because the
 * alternative is silent corruption on the first host that does something unusual, and
 * because it round-trips against our own parser -- a real property even without a host.
 *
 * Masked to a byte BEFORE the comparison, not after: `charCodeAt` yields a UTF-16 code
 * unit, and U+01FF is 511 rather than any group code but truncates to 0xFF. The same
 * trap telnet.ts's TERMINAL-TYPE reply documents.
 *
 * ITERATES CODE POINTS (`for...of` on a string), NOT CODE UNITS, which matters only if
 * a name ever contains a surrogate pair: `for...of` would yield the whole astral code
 * point as one `ch`, and `ch.charCodeAt(0)` reads only its LEADING surrogate (0xD800-
 * 0xDBFF), truncating to some byte in 0x00-0xDB with no ESC applied even if that byte
 * happens to collide with a group code -- a silent corruption one level below the
 * documented U+01FF truncation. Not worth handling: a device name is ASCII in every
 * known case (see the module-level comment's grep of x3270's trace collection), so no
 * real input reaches this path either way, and `parseEnvironSend`'s own byte-oriented
 * un-escaping has no way to reconstruct a code point that was never sent as bytes in
 * the first place -- the mangling would need fixing on the decode side too if it ever
 * mattered, not just here.
 */
export function escapeEnvironBytes(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const b = ch.charCodeAt(0) & 0xff;
    if (b === EnvironGroup.VAR || b === EnvironGroup.VALUE
      || b === EnvironGroup.ESC || b === EnvironGroup.USERVAR) {
      out.push(EnvironGroup.ESC);
    }
    out.push(b);
  }
  return out;
}

/**
 * Build the IS reply body for `requests`.
 *
 * Returns the body from the qualifier onward: the caller adds `IAC SB NEW-ENVIRON`
 * ahead of it and `IAC SE` after, and is responsible for IAC doubling -- see the
 * TERMINAL-TYPE reply in telnet.ts for the same division and the RFC 855 reason.
 *
 * THE MISSING-VARIABLE RULE IS THE ONE TO GET RIGHT: a name we do not have is echoed
 * with NO VALUE byte at all (x3270 appends VALUE only `if (value != NULL)`,
 * telnet_new_environ.c:561). That is distinguishable on the wire from a known variable
 * whose value is empty -- name + VALUE + nothing -- and emitting an empty VALUE for an
 * unknown name would claim we have a variable we do not.
 *
 * A WHOLE-GROUP DUMP (`name === ''`) EMITS THE GROUP BYTE PER VARIABLE, not once for
 * the group: x3270's own `name_len == 0` branch puts `vb_appendf(&reply, "%c",
 * ereq->group)` INSIDE the `FOREACH_LLIST` over that group's variables
 * (telnet_new_environ.c:532-537), building the same (group, name, VALUE, value) tuple
 * per entry that the single-name branch below it builds for one name. There is no
 * "dump the group header once" shape on the wire at all.
 *
 * A WHOLE-GROUP DUMP'S ORDER FOLLOWS THE MAP'S INSERTION ORDER, which callers should
 * treat as significant even though nothing here enforces a particular order: x3270's
 * own list is a `FOREACH_LLIST` over variables in the order `add_environ` inserted them
 * (`environ_init`, telnet_new_environ.c:220-245: USER, then DEVNAME, then IBMELF, then
 * IBMAPPLID, then CODEPAGE/CHARSET/KBDTYPE), and a host that has only ever seen that
 * order from real x3270 has no reason to expect another. `Map` iteration order is
 * insertion order per the ECMAScript spec, so a caller (Task 7) that populates the map
 * in x3270's order gets x3270's wire order for free.
 *
 * WE REQUIRE AN EXACT NAME MATCH, WHICH DIVERGES FROM x3270 DELIBERATELY. Its
 * `find_environ` compares `memcmp(name, e->name, namelen)` without checking that the
 * lengths agree (:159-175: only `namelen` bytes of the stored name are compared), so a
 * request for "IBM" matches its stored "IBMELF". That answers a question the host did
 * not ask; we do not copy it -- a plain `Map.get` already requires equality.
 */
export function buildEnvironIs(
  requests: readonly EnvironRequest[],
  vars: ReadonlyMap<string, string>,
  uservars: ReadonlyMap<string, string>,
): Uint8Array {
  const out: number[] = [EnvironQual.IS];
  const emit = (group: number, name: string, value: string | undefined): void => {
    out.push(group, ...escapeEnvironBytes(name));
    if (value !== undefined) out.push(EnvironGroup.VALUE, ...escapeEnvironBytes(value));
  };

  for (const req of requests) {
    const list = req.group === EnvironGroup.VAR ? vars : uservars;
    if (req.name === '') {
      // The whole group, in the map's insertion order -- see the doc comment above.
      for (const [name, value] of list) emit(req.group, name, value);
      continue;
    }
    emit(req.group, req.name, list.get(req.name));
  }
  return Uint8Array.from(out);
}
