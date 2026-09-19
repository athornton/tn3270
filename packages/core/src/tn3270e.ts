/**
 * TN3270E (RFC 2355): the option-40 subnegotiation state machine and the 5-byte
 * data header codec.
 *
 * PURE BY DESIGN — bytes in, decisions and bytes out, no socket and no session. The
 * negotiation is the part most likely to be wrong, and a pure function can be driven
 * directly with the transcript recorded from real s3270 in
 * docs/superpowers/specs/2026-08-27-stage2b-tn3270e-design.md. That is the same
 * reason queryreply.ts is pure.
 *
 * Design doc: docs/superpowers/specs/2026-08-27-stage2b-tn3270e-design.md
 * Plan:       docs/superpowers/plans/2026-08-27-stage2b-tn3270e.md
 */
import { Tn3270eDataType, Tn3270eFunc, Tn3270eOp, Tn3270eReason } from './constants.js';

/**
 * RFC 2355 §8.1: DATA-TYPE, REQUEST-FLAG, RESPONSE-FLAG, then a 2-byte SEQ-NUMBER.
 * x3270 calls the same number EH_SIZE (include/tn3270e.h).
 */
export const TN3270E_HEADER_BYTES = 5;

export interface Tn3270eHeader {
  dataType: number;
  requestFlag: number;
  responseFlag: number;
  seq: number;
}

/**
 * Build the true header bytes.
 *
 * DELIBERATELY DOES NOT ESCAPE 0xFF. RFC 2355 §8.1.4 requires that a 0xff inside
 * SEQ-NUMBER be doubled — "this is standard IAC escaping" — and it will be, by
 * doubleIac() in telnet.ts, which every outbound record already passes through.
 * Escaping here as well would double it twice, and would also mangle any record
 * whose 3270 payload happens to contain a 0xff. Prepend this to the payload and
 * hand the single buffer to sendRecord(), and the requirement is met by
 * construction rather than by a second escaping implementation that could drift out
 * of step with the first. The end-to-end behaviour is pinned at the session level.
 *
 * The `& 0xff` on each field is INTENT, NOT PROTECTION: `Uint8Array.of` already
 * truncates mod 256, established by deleting a mask and watching the test still
 * pass. They are kept because they say what the field is, and because they become
 * load-bearing the moment this is rewritten to build a `number[]` or write through a
 * DataView — neither of which truncates for you.
 */
export function encodeHeader(h: Tn3270eHeader): Uint8Array {
  return Uint8Array.of(
    h.dataType & 0xff,
    h.requestFlag & 0xff,
    h.responseFlag & 0xff,
    (h.seq >> 8) & 0xff,
    h.seq & 0xff,
  );
}

/**
 * Read a header off the front of an inbound record, or null if the record cannot
 * hold one.
 *
 * A record of exactly five bytes is valid and carries no data: RFC 2355 §8 permits
 * `<TN3270E Header><IAC EOR>`, which is how PRINT-EOJ arrives and how a bare
 * RESPONSE could. So the test is `< TN3270E_HEADER_BYTES`, not `<=`.
 *
 * Returns null rather than throwing. Four bytes is not a truncated message we can
 * salvage, it is a malformed one, and the caller should trace and drop it: a client
 * cannot correct a host, and an exception here would surface to the operator as a
 * program check the host never caused.
 */
export function decodeHeader(record: Uint8Array): Tn3270eHeader | null {
  if (record.length < TN3270E_HEADER_BYTES) return null;
  return {
    dataType: record[0]!,
    requestFlag: record[1]!,
    responseFlag: record[2]!,
    seq: (record[3]! << 8) | record[4]!,
  };
}

/**
 * True only for the data type that carries a 3270 datastream we can execute.
 *
 * This is the gate that keeps a bind image, an unbind reason code or NVT text out of
 * the 3270 executor, where any of them would produce a spurious program check
 * attributable to nothing the host did wrong. SCS-DATA is excluded too: it is SNA
 * Character Stream, which belongs to the printer session rather than here.
 */
export function carriesDatastream(dataType: number): boolean {
  return dataType === Tn3270eDataType.DATA_3270;
}

/**
 * The functions we ask for.
 *
 * BIND-IMAGE IS REQUESTED, and the hazard that once justified omitting it has been
 * measured away. Granted BIND-IMAGE and sent no BIND, real s3270 never enters 3270
 * mode (telnet.c:2339, and the gate at telnet.c:2681 that drops 3270_DATA until
 * `tn3270e_bound`). THAT REMAINS TRUE. What changed is knowing how often it happens:
 * 29 of 29 hosts in x3270's own trace collection that grant BIND-IMAGE send a BIND
 * immediately after FUNCTIONS, counted BY BYTES across all 71 traces -- grepping for
 * decoded `< BIND` annotation lines gives a FALSE answer, because older traces carry
 * no annotations. The advertise-then-stay-silent case exists only in our own
 * e-server.py, which we configured to do it.
 *
 * So we adopt the gate deliberately AND refuse to inherit the hang: a pre-BIND
 * 3270-DATA record is retained and executed if NO_BIND_TIMEOUT_MS expires (bind.ts).
 * Asking for it is what gives BIND, UNBIND and the whole geometry channel a
 * verification path at all -- 46 recorded traces stop dead at FUNCTIONS without it.
 *
 * The two printer functions, SCS-CTL-CODES and DATA-STREAM-CTL, are printer-session
 * functions by RFC 2355 §7.2.2 and belong to the printer stage.
 *
 * CONTENTION-RESOLUTION is not in RFC 2355 at all; x3270 requests it and so do we,
 * but nothing here depends on a host granting it.
 *
 * ORDER MATTERS TO THE TESTS, NOT TO THE PROTOCOL: this is s3270's own order
 * (00 02 04 05), so a byte-for-byte comparison against a recorded s3270 FUNCTIONS
 * REQUEST matches without sorting either side.
 */
export const REQUESTED_FUNCTIONS: readonly number[] = [
  Tn3270eFunc.BIND_IMAGE,
  Tn3270eFunc.RESPONSES,
  Tn3270eFunc.SYSREQ,
  Tn3270eFunc.CONTENTION_RESOLUTION,
];

/**
 * The functions THIS session asks for. Defaults to REQUESTED_FUNCTIONS; with
 * `bindImage` false (`SessionOptions.bindImage`, Task 11's `-bind-image off`),
 * BIND-IMAGE is left out of the request.
 *
 * A FUNCTION, DELIBERATELY NOT A MUTATION OF THE CONSTANT: `REQUESTED_FUNCTIONS`
 * stays the fixed default-on list so the conformance tests above (a byte-for-byte
 * comparison against a recorded s3270 FUNCTIONS REQUEST) keep comparing against
 * exactly what they always have, and so every existing caller that reads the
 * constant directly keeps working unchanged.
 *
 * THE RESULT OF THIS CALL IS WHAT `addsNothing` MUST BE JUDGED AGAINST, not
 * `REQUESTED_FUNCTIONS` itself. If `addsNothing` used the constant instead, a host
 * that grants BIND-IMAGE on a session that asked it OFF would look like it "added
 * nothing" -- because BIND-IMAGE is still in the constant -- and would be silently
 * adopted into `agreed`. `bindImageGranted()` (session.ts) reads `agreed` alone, so
 * the BIND gate would then arm itself on a session whose operator specifically
 * asked to skip the whole BIND/UNBIND channel: exactly the outcome `-bind-image off`
 * exists to prevent, reached anyway because the refusal check consulted the wrong
 * list.
 */
export function requestedFunctions(bindImage: boolean): readonly number[] {
  return bindImage
    ? REQUESTED_FUNCTIONS
    : REQUESTED_FUNCTIONS.filter((f) => f !== Tn3270eFunc.BIND_IMAGE);
}

export type Tn3270ePhase =
  | 'idle'
  | 'awaitingDeviceType'
  | 'awaitingFunctions'
  | 'negotiated'
  | 'backedOff';

export interface Tn3270eState {
  readonly phase: Tn3270ePhase;
  /** Functions agreed. Empty with phase 'negotiated' is "basic TN3270E" (§9). */
  readonly agreed: readonly number[];
  readonly terminalType: string;
  /** LU names still to try, in order. Advanced on REJECT. */
  readonly lus: readonly string[];
  readonly luIndex: number;
  readonly deviceType?: string;
  /** The LU the SERVER reported, which need not be the one we asked for. */
  readonly lu?: string;
  /**
   * THE FUNCTIONS THIS SESSION ASKS FOR, fixed at `initialState()` time by
   * `requestedFunctions(bindImage)`. Per-session in exactly the way `terminalType`
   * and `lus` already are: `-bind-image off` (Task 11) must change what one
   * session requests without touching any other session's negotiation, including
   * one already in flight on a different connection.
   *
   * Carried on the STATE, not threaded as a parameter to `negotiate()`, because
   * `negotiate()` is pure and already receives the state on every call -- adding a
   * parameter to a pure function that is called from three places inside itself
   * (the FUNCTIONS REQUEST reply, the counter-offer, and `addsNothing`) would mean
   * getting it right at three call sites instead of one field read from `st`.
   */
  readonly requested: readonly number[];
}

export type Tn3270eEffect =
  | { kind: 'complete'; agreed: readonly number[] }
  | { kind: 'backoff'; why: string };

export interface NegotiateResult {
  readonly next: Tn3270eState;
  /** Subnegotiation body to send, WITHOUT the option byte. The caller frames it. */
  readonly reply?: Uint8Array;
  readonly effect?: Tn3270eEffect;
}

export function initialState(
  o: { terminalType: string; lus: readonly string[]; bindImage?: boolean },
): Tn3270eState {
  return {
    phase: 'idle',
    agreed: [],
    terminalType: o.terminalType,
    lus: o.lus,
    luIndex: 0,
    // Defaults to on, matching `SessionOptions.bindImage`'s own default -- see that
    // field's comment in session.ts.
    requested: requestedFunctions(o.bindImage ?? true),
  };
}

const toAscii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const fromAscii = (b: Uint8Array): string => String.fromCharCode(...b);


/** Every function code we know. An inbound code outside this is "unrecognized". */
const KNOWN_FUNCS: readonly number[] = Object.values(Tn3270eFunc);

/**
 * Decode a function list, discarding codes we do not know.
 *
 * RFC 2355 §7.2.2 requires exactly this: "If in the process of functions negotiation
 * an unrecognized function code is recieved, the recipient should simply remove that
 * function code from the list and continue normal functions negotiation." So an
 * unknown code is NOT an error and must not abort the session.
 *
 * DISCARDING MUST HAPPEN BEFORE the addsNothing() comparison. Judged the other way
 * round, an unknown code looks like an illegal addition and triggers backoff, turning
 * a conforming server into a refused one. x3270 gets this for free by decoding into a
 * bitmap that cannot hold an unknown bit (tn3270e_fdecode).
 */
function decodeFuncs(list: Uint8Array): number[] {
  return [...list].filter((f) => KNOWN_FUNCS.includes(f));
}

/**
 * True when `offered` contains nothing outside THIS SESSION's requested list
 * (`st.requested`), NOT the module constant `REQUESTED_FUNCTIONS`.
 *
 * See `Tn3270eState.requested`'s comment for what goes wrong if this read the
 * constant instead: with `-bind-image off`, BIND-IMAGE would look like something
 * we always ask for and a host granting it unasked would be silently accepted.
 */
function addsNothing(st: Tn3270eState, offered: readonly number[]): boolean {
  return offered.every((f) => st.requested.includes(f));
}

/** Build DEVICE-TYPE REQUEST <ttype> [CONNECT <lu>] for the state's current LU. */
function deviceTypeRequest(st: Tn3270eState): Uint8Array {
  const lu = st.lus[st.luIndex];
  return Uint8Array.from([
    Tn3270eOp.DEVICE_TYPE, Tn3270eOp.REQUEST, ...toAscii(st.terminalType),
    ...(lu === undefined ? [] : [Tn3270eOp.CONNECT, ...toAscii(lu)]),
  ]);
}

/**
 * Advance the negotiation by one received subnegotiation body.
 *
 * `body` excludes the option byte AND the trailing IAC SE, so `body[0]` is the first
 * operation. (x3270 keeps the SE in its sbbuf, which is why its parser scans for it
 * — telnet.c:2219 — while ours can scan to the end of the buffer instead.)
 *
 * Pure: returns a new state and never mutates the one it was handed, so the session
 * can decide what to do with the result before adopting it.
 *
 * An unrecognized or misordered body yields no reply and no state change. Silence is
 * the correct response to a message we cannot parse, and it is exactly what real
 * s3270 does when handed a misordered SEND DEVICE-TYPE.
 */
export function negotiate(st: Tn3270eState, body: Uint8Array): NegotiateResult {
  // SEND DEVICE-TYPE. THE VERB COMES FIRST HERE (0x08 0x02) and the noun first in
  // our reply (0x02 0x07). That asymmetry is real -- x3270 pins it at telnet.c:2199,
  // where the test is `sbbuf[2] == TN3270E_OP_DEVICE_TYPE` -- and reversing it makes
  // s3270 log "DEVICE-TYPE ??8" and then stall, with no reject and no error.
  if (body[0] === Tn3270eOp.SEND && body[1] === Tn3270eOp.DEVICE_TYPE) {
    return {
      next: { ...st, phase: 'awaitingDeviceType' },
      reply: deviceTypeRequest(st),
    };
  }

  if (body[0] === Tn3270eOp.DEVICE_TYPE && body[1] === Tn3270eOp.IS) {
    // DEVICE-TYPE IS <type> [CONNECT <name>]; the CONNECT clause is optional and
    // §7.1.4 does not require it. x3270 scans to SE or CONNECT (telnet.c:2219-2221);
    // our body has no SE, so end-of-buffer plays that role.
    const rest = body.subarray(2);
    const sep = rest.indexOf(Tn3270eOp.CONNECT);
    const type = fromAscii(sep === -1 ? rest : rest.subarray(0, sep));
    const lu = sep === -1 ? '' : fromAscii(rest.subarray(sep + 1));
    return {
      // An empty name is treated as no LU, not as an LU called nothing: only one of
      // those should reach the status line.
      next: {
        ...st, phase: 'awaitingFunctions', deviceType: type,
        ...(lu === '' ? {} : { lu }),
      },
      reply: Uint8Array.from([
        Tn3270eOp.FUNCTIONS, Tn3270eOp.REQUEST, ...st.requested,
      ]),
    };
  }

  if (body[0] === Tn3270eOp.FUNCTIONS && body[1] === Tn3270eOp.IS) {
    const offered = decodeFuncs(body.subarray(2));
    if (!addsNothing(st, offered)) {
      // x3270 calls this "Host illegally added function(s)" (telnet.c:2327) and
      // abandons TN3270E outright rather than trying to reconcile. So do we: a server
      // that grants what we did not request is not one to keep bargaining with.
      // BIND-IMAGE does not exercise this branch on a session that requested it (the
      // default) -- what lands here then is a printer function or anything else
      // outside the four we ask for. On a session built with `-bind-image off`
      // (Task 11), BIND-IMAGE is EXCLUDED from `st.requested` and so DOES land here
      // if the host grants it anyway: that is the whole protection `-bind-image off`
      // relies on, since `addsNothing` above is judged against `st.requested`, not
      // the fixed module constant.
      return {
        next: { ...st, phase: 'backedOff' },
        effect: { kind: 'backoff', why: 'host illegally added function(s)' },
      };
    }
    // SILENCE IS THE REPLY. Real s3270 sends nothing here, and an echoed FUNCTIONS IS
    // would still appear to work against a tolerant server -- which is why the
    // absence of a reply is asserted in the tests.
    //
    // An empty list is legal and completes: RFC 2355 §9 calls it "basic TN3270E".
    return {
      next: { ...st, phase: 'negotiated', agreed: offered },
      effect: { kind: 'complete', agreed: offered },
    };
  }

  if (body[0] === Tn3270eOp.FUNCTIONS && body[1] === Tn3270eOp.REQUEST) {
    const offered = decodeFuncs(body.subarray(2));
    if (addsNothing(st, offered)) {
      // They want what we want, or less: adopt it, confirm with IS, and finish
      // (telnet.c:2293-2301).
      return {
        next: { ...st, phase: 'negotiated', agreed: offered },
        reply: Uint8Array.from([Tn3270eOp.FUNCTIONS, Tn3270eOp.IS, ...offered]),
        effect: { kind: 'complete', agreed: offered },
      };
    }
    // They want something we cannot do: counter with the common subset and STAY in
    // negotiation (telnet.c:2306-2311). No 'complete' effect here -- emitting one
    // would put the session in 3270 mode before the host has agreed to anything.
    const common = offered.filter((f) => st.requested.includes(f));
    return {
      next: { ...st, phase: 'awaitingFunctions' },
      reply: Uint8Array.from([Tn3270eOp.FUNCTIONS, Tn3270eOp.REQUEST, ...common]),
    };
  }

  if (body[0] === Tn3270eOp.DEVICE_TYPE && body[1] === Tn3270eOp.REJECT) {
    // THE REASON IS CHECKED BEFORE TRYING ANOTHER LU, matching telnet.c:2263-2267.
    // UNSUPPORTED-REQ is about the request TYPE rather than the resource, so no other
    // LU would fare better and retrying would only add noise to the wire.
    //
    // body[3] is undefined when the REASON clause is absent, which §7.1.5 shows as
    // present but a truncated body could omit. undefined compares equal to nothing,
    // so it falls through to the rejection paths below rather than throwing or being
    // mistaken for success.
    const reason = body[2] === Tn3270eOp.REASON ? body[3] : undefined;
    if (reason === Tn3270eReason.UNSUPPORTED_REQ) {
      return {
        next: { ...st, phase: 'backedOff' },
        effect: { kind: 'backoff', why: 'host rejected request type' },
      };
    }
    const nextIndex = st.luIndex + 1;
    if (nextIndex < st.lus.length) {
      // deviceTypeRequest() is given the UPDATED state so it reads the new luIndex.
      // Passing `st` would resend the name that was just rejected -- an endless
      // exchange against a host that keeps saying no, which is much harder to
      // diagnose than a clean failure.
      const next: Tn3270eState = {
        ...st, luIndex: nextIndex, phase: 'awaitingDeviceType',
      };
      return { next, reply: deviceTypeRequest(next) };
    }
    // Out of LUs, or there never were any. x3270 distinguishes the two messages
    // (telnet.c:2275-2277), and the distinction is what tells an operator whether to
    // fix an LU name or the model.
    return {
      next: { ...st, phase: 'backedOff' },
      effect: {
        kind: 'backoff',
        why: st.lus.length > 0 ? 'host rejected resource(s)' : 'device type rejected',
      },
    };
  }

  return { next: st };
}
