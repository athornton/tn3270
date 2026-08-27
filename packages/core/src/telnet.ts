import { TelnetCmd as T, TelnetOpt as O, TelnetSubopt as S, TERMINAL_TYPE } from './constants.js';
import type { Trace } from './trace.js';

/**
 * Telnet option negotiation and 3270 record framing.
 *
 * The framer is a byte-at-a-time state machine because a 3270 record has no
 * length field: it ends at IAC EOR, which can land anywhere relative to a TCP
 * segment boundary. Never assume a chunk is a record.
 */

export interface TelnetLayerOptions {
  write: (bytes: Uint8Array) => void;
  onRecord: (record: Uint8Array) => void;
  trace?: Trace;
  terminalType?: string;
  /** Offer TN3270E when the host asks. Default true; `-tn3270e off` clears it. */
  tn3270eEnabled?: boolean;
  /** Receives a TN3270E subnegotiation body with the option byte stripped. */
  onTn3270eSubneg?: (body: Uint8Array) => void;
}

enum St { Data, Iac, Will, Wont, Do, Dont, Sb, SbIac }

/** Options we actively want. */
const DESIRED = new Set<number>([O.BINARY, O.TERMINAL_TYPE, O.EOR, O.SUPPRESS_GO_AHEAD]);

/**
 * Ceilings on the two per-byte accumulators.
 *
 * A record has no length field, so neither can be pre-sized — but both are
 * `number[]`, which boxes each byte at roughly 32 bytes of heap. Without a
 * ceiling, a host that never sends IAC EOR (or a stream desynchronized so that
 * EOR is consumed as an option byte) grows the heap ~32x the wire rate until the
 * process dies. A full 3278-2 rewrite is a few KB, so 64 KB is generous.
 */
export const MAX_RECORD_BYTES = 65536;
/** x3270 uses a 1024-byte sbbuf (telnet.c:1806); it does not bounds-check, we do. */
export const MAX_SUBNEG_BYTES = 1024;

/**
 * Copy `body` with every 0xFF doubled, as telnet requires of data bytes.
 *
 * RFC 854, TELNET COMMAND STRUCTURE (p.13-14): "With the current set-up, only
 * the IAC need be doubled to be sent as data, and the other 255 codes may be
 * passed transparently."
 *
 * Body only: the caller appends its own framing (IAC EOR for a 3270 record, IAC
 * SE for a subnegotiation) *after* this returns, because that trailing IAC is a
 * command introducer and must stay single. x3270 draws the same line, though
 * from the other side — it builds the framed buffer first and then tells
 * net_hexnvt_out_framed() to skip the ends (telnet.c:3003-3004). Keeping the
 * framing outside is equivalent and needs no special cases.
 *
 * Shared by the record and subnegotiation paths deliberately: they carry
 * different payloads (3270 data vs telnet option data) and end with different
 * framing, but the escaping rule is one rule, and having it in one place is why
 * only one of the two could drift out of step in the first place.
 */
function doubleIac(body: Iterable<number>): number[] {
  const out: number[] = [];
  for (const b of body) {
    out.push(b);
    if (b === T.IAC) out.push(T.IAC);
  }
  return out;
}

export class TelnetLayer {
  private readonly write: (bytes: Uint8Array) => void;
  private readonly onRecord: (record: Uint8Array) => void;
  private readonly trace: Trace | undefined;
  private readonly terminalType: string;
  private readonly tn3270eEnabled: boolean;
  private readonly onTn3270eSubneg: ((body: Uint8Array) => void) | undefined;
  /** Set once DEVICE-TYPE and FUNCTIONS have both completed. */
  private tn3270eNegotiated = false;

  private state = St.Data;
  private record: number[] = [];
  private sb: number[] = [];
  /** Set when the current record blew the ceiling; suppresses its delivery. */
  private overlongRecord = false;

  /** Options we have told the host WE will do. */
  private readonly myOpts = new Set<number>();
  /** Options we have told the host IT may do. */
  private readonly hisOpts = new Set<number>();

  constructor(opts: TelnetLayerOptions) {
    this.write = opts.write;
    this.onRecord = opts.onRecord;
    this.trace = opts.trace;
    this.terminalType = opts.terminalType ?? TERMINAL_TYPE;
    this.tn3270eEnabled = opts.tn3270eEnabled ?? true;
    this.onTn3270eSubneg = opts.onTn3270eSubneg;
  }

  /**
   * True once BINARY and EOR are agreed in both directions — the point at
   * which the byte stream is 3270 records rather than NVT text.
   */
  is3270Mode(): boolean {
    // TWO ROUTES, AND THE SECOND IS NOT OPTIONAL. Classic TN3270 arrives here by
    // agreeing BINARY and EOR in both directions. TN3270E arrives by completing its
    // own negotiation, because RFC 2355 §4 makes binary and EOR IMPLIED rather than
    // negotiated: "a party to the negotiation that agrees to support TN3270E is
    // automatically required to support bi-directional binary and EOR
    // transmissions."
    //
    // Measured 2026-08-27: a server sending only `IAC DO TN3270E` -- no BINARY, no
    // EOR -- still gets 3270 records out of real s3270. With only the classic test
    // here, such a session negotiates perfectly and then discards every inbound byte
    // in storeRecordByte() and every record in flushRecord(), presenting as a blank
    // screen with a trace full of "EOR received outside 3270 mode".
    //
    // Negotiation COMPLETE, not merely the option agreed: during DEVICE-TYPE and
    // FUNCTIONS there is no datastream yet. That is the distinction s3270 draws
    // between its connected-unbound and connected-tn3270e states.
    if (this.tn3270eNegotiated) return true;
    return (
      this.myOpts.has(O.BINARY) && this.hisOpts.has(O.BINARY) &&
      this.myOpts.has(O.EOR) && this.hisOpts.has(O.EOR)
    );
  }

  /** Called by the session when TN3270E negotiation completes, or is abandoned. */
  setTn3270eNegotiated(v: boolean): void {
    this.tn3270eNegotiated = v;
  }

  receive(chunk: Uint8Array): void {
    this.trace?.recv(chunk);
    for (const c of chunk) this.step(c);
  }

  /** Frame and transmit one inbound 3270 record. */
  sendRecord(payload: Uint8Array): void {
    const out = doubleIac(payload);
    out.push(T.IAC, T.EOR);
    const bytes = Uint8Array.from(out);
    this.trace?.send(bytes);
    this.write(bytes);
  }

  /** The 3270 Attn key is Telnet BREAK (RFC 1576 §8), not an AID. */
  sendAttn(): void {
    const bytes = Uint8Array.of(T.IAC, T.BREAK);
    this.trace?.send(bytes, 'Attn (IAC BREAK)');
    this.write(bytes);
  }

  private step(c: number): void {
    switch (this.state) {
      case St.Data:
        if (c === T.IAC) {
          this.state = St.Iac;
        } else {
          this.storeRecordByte(c);
        }
        return;

      case St.Iac:
        switch (c) {
          case T.IAC:
            // An escaped IAC is data, so it goes through exactly the same two
            // gates as a plain data byte in St.Data: it is dropped outside 3270
            // mode, and it counts against MAX_RECORD_BYTES. Pushing it
            // unconditionally leaked a 0xFF out of the pre-3270 banner into the
            // head of the first real record, and let a stream of IAC IAC grow
            // the accumulator past the ceiling. See storeRecordByte for the
            // x3270 lines.
            this.state = St.Data;
            this.storeRecordByte(0xff);
            return;
          case T.EOR:
            this.state = St.Data;
            this.flushRecord();
            return;
          case T.WILL: this.state = St.Will; return;
          case T.WONT: this.state = St.Wont; return;
          case T.DO: this.state = St.Do; return;
          case T.DONT: this.state = St.Dont; return;
          case T.SB: this.sb = []; this.state = St.Sb; return;
          case T.NOP:
            // A liveness probe. Explicitly no reply (RFC 1576 §5).
            this.state = St.Data;
            return;
          default:
            this.state = St.Data;
            return;
        }

      case St.Do:
        this.onDo(c);
        this.state = St.Data;
        return;

      case St.Dont:
        if (this.myOpts.delete(c)) this.reply(T.WONT, c);
        this.state = St.Data;
        return;

      case St.Will:
        this.onWill(c);
        this.state = St.Data;
        return;

      case St.Wont:
        if (this.hisOpts.delete(c)) this.reply(T.DONT, c);
        this.state = St.Data;
        return;

      case St.Sb:
        if (c === T.IAC) {
          this.state = St.SbIac;
        } else {
          this.storeSubnegByte(c);
        }
        return;

      case St.SbIac:
        if (c === T.SE) {
          this.handleSubnegotiation();
          this.state = St.Data;
        } else {
          // Not SE, so this is subnegotiation data. IAC IAC therefore stores one
          // 0xFF — the inbound un-doubling that mirrors what we now do on the
          // way out. x3270's TNS_SB_IAC has the same shape: it stores the byte
          // unconditionally with `*sbptr++ = c` and, for c != SE, falls out of
          // the `if` leaving that single copy (telnet.c:1994-1996). Note x3270
          // therefore keeps the trailing SE in sbbuf and we do not, which is why
          // its TN3270E parser has to scan for SE to find the length
          // (telnet.c:2188-2193) while our `sb` is already exactly the body.
          //
          // This must go through the same ceiling as St.Sb. It did not, so a
          // body of IAC IAC pairs bypassed MAX_SUBNEG_BYTES entirely: measured
          // at 200001 accumulated entries against a 1024-byte cap, which is the
          // heap exhaustion the cap exists to prevent, reached through the
          // escaped-byte door.
          this.state = St.Sb;
          this.storeSubnegByte(c);
        }
        return;
    }
  }

  /**
   * Append one already-unescaped byte to the subnegotiation accumulator.
   *
   * An unterminated subnegotiation would otherwise eat the session: St.Sb is left
   * only on IAC SE, so without a ceiling the rest of the stream is silently
   * consumed and the client presents as a hang. x3270 allocates a fixed
   * 1024-byte sbbuf (telnet.c:1806) and does not bounds-check it; we do.
   */
  private storeSubnegByte(b: number): void {
    if (this.sb.length >= MAX_SUBNEG_BYTES) {
      this.trace?.note(`subnegotiation exceeded ${MAX_SUBNEG_BYTES} bytes, abandoned`);
      this.sb = [];
      this.state = St.Data;
      return;
    }
    this.sb.push(b);
  }

  /**
   * Append one already-unescaped data byte to the record accumulator.
   *
   * Outside 3270 mode the byte is NVT text — a logon banner or a session manager
   * prompt. It must NOT enter the record accumulator, or it gets prepended to
   * the first real 3270 record and the parser reads a banner character as the
   * command byte. Stage 1 renders no NVT text, so dropping it is correct.
   *
   * x3270 applies this same `if (IN_NVT && !IN_E) ... else store3270in(c)` gate
   * separately in each of the two places that store a data byte: once in
   * TNS_DATA for a plain byte (telnet.c:1703, 1735-1736) and again in TNS_IAC
   * for an escaped one (telnet.c:1745, 1772-1773). Both of our callers funnel
   * through here instead, so the two cannot disagree.
   */
  private storeRecordByte(b: number): void {
    if (!this.is3270Mode()) return;
    if (this.record.length >= MAX_RECORD_BYTES) {
      this.trace?.note(`record exceeded ${MAX_RECORD_BYTES} bytes, discarded`);
      this.record = [];
      this.overlongRecord = true;
      return;
    }
    this.record.push(b);
  }

  /** Host asks us to enable an option. */
  private onDo(opt: number): void {
    // Before the DESIRED test, because option 40 is CONDITIONAL and DESIRED is a
    // constant set. The RFC 854 "only on a real change" guard applies here too.
    if (opt === O.TN3270E) {
      if (!this.tn3270eEnabled) {
        this.reply(T.WONT, opt);
        return;
      }
      if (!this.myOpts.has(opt)) {
        this.myOpts.add(opt);
        this.reply(T.WILL, opt);
      }
      return;
    }
    if (DESIRED.has(opt)) {
      if (!this.myOpts.has(opt)) {
        this.myOpts.add(opt);
        this.reply(T.WILL, opt);
      }
      return;
    }
    if (opt === O.ECHO) {
      // Some hosts renegotiate ECHO repeatedly during a pre-3270 NVT login.
      // Answer as asked, but only on a real change: RFC 854 requires that a
      // request to enter a mode we are already in go unacknowledged, "essential
      // to prevent endless loops in the negotiation". x3270 guards every
      // accepted option the same way (telnet.c:2000, `if (!myopts[c])`).
      // Stage 1 implements no NVT-mode local echo.
      if (!this.myOpts.has(opt)) {
        this.myOpts.add(opt);
        this.reply(T.WILL, opt);
      }
      return;
    }
    // Everything else, including TN3270E, TIMING-MARK and 3270-REGIME.
    this.reply(T.WONT, opt);
  }

  /** Host offers to enable an option. */
  private onWill(opt: number): void {
    if (opt === O.BINARY || opt === O.EOR) {
      if (!this.hisOpts.has(opt)) {
        this.hisOpts.add(opt);
        this.reply(T.DO, opt);
      }
      return;
    }
    this.reply(T.DONT, opt);
  }

  private handleSubnegotiation(): void {
    if (this.sb[0] === O.TN3270E) {
      // Hand up the body only. The option byte is framing, and the trailing SE is
      // already absent because our accumulator drops it (see St.SbIac) -- which is
      // why the consumer can scan to end-of-buffer where x3270 has to scan for SE.
      // IAC IAC has already been un-doubled by storeSubnegByte.
      const body = Uint8Array.from(this.sb.slice(1));
      this.sb = [];
      this.onTn3270eSubneg?.(body);
      return;
    }
    if (this.sb[0] === O.TERMINAL_TYPE && this.sb[1] === S.SEND) {
      // The ttype is a subnegotiation *parameter*, so a 0xFF inside it must be
      // doubled like any other data byte. RFC 855 says so explicitly, in its
      // last paragraph: "Finally, if parameters in an option "subnegotiation"
      // include a byte with a value of 255, it is necessary to double this byte
      // in accordance the general TELNET rules." (RFC 1091, which defines
      // TERMINAL-TYPE, is silent — it just calls the ttype "an NVT ASCII
      // string" — so RFC 855 is the governing text.) x3270 does the same, by
      // running its assembled reply through net_hexnvt_out_framed(..., true)
      // at telnet.c:2025.
      //
      // Mask before testing for IAC, not after. charCodeAt yields a UTF-16 code
      // unit, which Uint8Array.from would silently truncate mod 256 — U+01FF is
      // 511, is not equal to T.IAC, and truncates to 0xFF, so doubling the
      // untruncated value would still put a bare IAC on the wire.
      const name = Array.from(this.terminalType, (ch) => ch.charCodeAt(0) & 0xff);
      const body = doubleIac(name);
      // The leading IAC SB and trailing IAC SE bracket the body and are commands,
      // not data: they stay single.
      const out = Uint8Array.from([
        T.IAC, T.SB, O.TERMINAL_TYPE, S.IS, ...body, T.IAC, T.SE,
      ]);
      this.trace?.send(out, `TERMINAL-TYPE IS ${this.terminalType}`);
      this.write(out);
      this.sb = [];
      return;
    }
    // Anything else is dropped; we advertised nothing that needs it.
    const optLabel = this.sb.length > 0 ? String(this.sb[0]) : '(empty)';
    this.trace?.note(`ignored subnegotiation for option ${optLabel}`);
    this.sb = [];
  }

  private flushRecord(): void {
    if (!this.is3270Mode()) {
      // EOR before negotiation completed. x3270 logs and discards the
      // accumulator (telnet.c:1848-1859, `ibptr = ibuf`); so do we.
      if (this.record.length > 0) {
        this.trace?.note(`EOR received outside 3270 mode, ${this.record.length} bytes discarded`);
        this.record = [];
      }
      return;
    }
    if (this.overlongRecord) {
      // The record already exceeded MAX_RECORD_BYTES and was dropped; deliver
      // nothing rather than a truncated tail, and resync for the next one.
      this.overlongRecord = false;
      this.record = [];
      return;
    }
    if (this.record.length === 0) return; // nothing to deliver
    const rec = Uint8Array.from(this.record);
    this.record = [];
    this.onRecord(rec);
  }

  /**
   * Frame and send a TN3270E subnegotiation body.
   *
   * The body is doubled and the brackets are not, exactly as the TERMINAL-TYPE path
   * does it: a 0xff in a subnegotiation parameter is data and must be doubled
   * (RFC 855, final paragraph), while the IAC of IAC SB and IAC SE is a command
   * introducer and stays single.
   */
  sendTn3270eSubneg(body: Uint8Array): void {
    const out = Uint8Array.from([
      T.IAC, T.SB, O.TN3270E, ...doubleIac(body), T.IAC, T.SE,
    ]);
    this.trace?.send(out, 'TN3270E subnegotiation');
    this.write(out);
  }

  /**
   * Abandon TN3270E and fall back to traditional tn3270.
   *
   * Modelled on x3270's backoff_tn3270e(): tell the host no, then forget we ever had
   * the option, so both the classic BINARY/EOR route and a later renegotiation are
   * still reachable on this same layer. Latching it off would make a reconnect
   * silently decline. This is what makes on-by-default safe.
   */
  refuseTn3270e(): void {
    this.myOpts.delete(O.TN3270E);
    this.tn3270eNegotiated = false;
    this.reply(T.WONT, O.TN3270E);
  }

  private reply(cmd: number, opt: number): void {
    const bytes = Uint8Array.of(T.IAC, cmd, opt);
    this.trace?.send(bytes);
    this.write(bytes);
  }
}
