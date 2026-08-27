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
import { Tn3270eDataType, Tn3270eFunc, Tn3270eOp } from './constants.js';

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
 * BIND-IMAGE IS DELIBERATELY ABSENT, and the reason is a measured hazard rather than
 * a cost. Granted BIND-IMAGE and sent no BIND, real s3270 never enters 3270 mode:
 * an Erase/Write is delivered and ignored, and Wait(3270Mode) times out. Granting it
 * WITH a BIND works, and denying it works. Since only advertise-then-stay-silent
 * hangs, not asking is what stops a server from putting us in that state at all.
 * x3270 accepts the risk (telnet.c:949-953); we need not. Three configurations
 * tabulated in docs/live-testing.md, *TN3270E harness validation*.
 *
 * The two printer functions, SCS-CTL-CODES and DATA-STREAM-CTL, are printer-session
 * functions by RFC 2355 §7.2.2 and belong to the printer stage.
 *
 * CONTENTION-RESOLUTION is not in RFC 2355 at all; x3270 requests it and so do we,
 * but nothing here depends on a host granting it.
 */
export const REQUESTED_FUNCTIONS: readonly number[] = [
  Tn3270eFunc.RESPONSES,
  Tn3270eFunc.SYSREQ,
  Tn3270eFunc.CONTENTION_RESOLUTION,
];

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
  o: { terminalType: string; lus: readonly string[] },
): Tn3270eState {
  return {
    phase: 'idle',
    agreed: [],
    terminalType: o.terminalType,
    lus: o.lus,
    luIndex: 0,
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

/** True when `offered` contains nothing outside REQUESTED_FUNCTIONS. */
function addsNothing(offered: readonly number[]): boolean {
  return offered.every((f) => REQUESTED_FUNCTIONS.includes(f));
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
        Tn3270eOp.FUNCTIONS, Tn3270eOp.REQUEST, ...REQUESTED_FUNCTIONS,
      ]),
    };
  }

  if (body[0] === Tn3270eOp.FUNCTIONS && body[1] === Tn3270eOp.IS) {
    const offered = decodeFuncs(body.subarray(2));
    if (!addsNothing(offered)) {
      // x3270 calls this "Host illegally added function(s)" (telnet.c:2327) and
      // abandons TN3270E outright rather than trying to reconcile. So do we: a server
      // that grants what we did not request is not one to keep bargaining with, and
      // BIND-IMAGE forced on us is precisely the case that could then hang the
      // session by never sending a BIND.
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
    if (addsNothing(offered)) {
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
    const common = offered.filter((f) => REQUESTED_FUNCTIONS.includes(f));
    return {
      next: { ...st, phase: 'awaitingFunctions' },
      reply: Uint8Array.from([Tn3270eOp.FUNCTIONS, Tn3270eOp.REQUEST, ...common]),
    };
  }

  return { next: st };
}
