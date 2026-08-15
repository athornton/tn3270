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
/** x3270 uses a 1024-byte sbbuf (telnet.c:1876); it does not bounds-check, we do. */
export const MAX_SUBNEG_BYTES = 1024;

export class TelnetLayer {
  private readonly write: (bytes: Uint8Array) => void;
  private readonly onRecord: (record: Uint8Array) => void;
  private readonly trace: Trace | undefined;
  private readonly terminalType: string;

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
  }

  /**
   * True once BINARY and EOR are agreed in both directions — the point at
   * which the byte stream is 3270 records rather than NVT text.
   */
  is3270Mode(): boolean {
    return (
      this.myOpts.has(O.BINARY) && this.hisOpts.has(O.BINARY) &&
      this.myOpts.has(O.EOR) && this.hisOpts.has(O.EOR)
    );
  }

  receive(chunk: Uint8Array): void {
    this.trace?.recv(chunk);
    for (const c of chunk) this.step(c);
  }

  /** Frame and transmit one inbound 3270 record. */
  sendRecord(payload: Uint8Array): void {
    const out: number[] = [];
    for (const b of payload) {
      out.push(b);
      if (b === T.IAC) out.push(T.IAC); // double IAC in data
    }
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
        } else if (this.is3270Mode()) {
          if (this.record.length >= MAX_RECORD_BYTES) {
            this.trace?.note(`record exceeded ${MAX_RECORD_BYTES} bytes, discarded`);
            this.record = [];
            this.overlongRecord = true;
          } else {
            this.record.push(c);
          }
        }
        // Outside 3270 mode the byte is NVT text — a logon banner or a session
        // manager prompt. It must NOT enter the record accumulator, or it gets
        // prepended to the first real 3270 record and the parser reads a banner
        // character as the command byte. x3270 gates this at telnet.c:1773
        // (`if (IN_NVT && !IN_E) ... else store3270in(c)`). Stage 1 renders no
        // NVT text, so dropping it is correct.
        return;

      case St.Iac:
        switch (c) {
          case T.IAC:
            this.record.push(0xff); // escaped IAC is data
            this.state = St.Data;
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
        } else if (this.sb.length >= MAX_SUBNEG_BYTES) {
          // Unterminated subnegotiation. St.Sb is left only on IAC SE, so
          // without this the rest of the session is silently consumed and the
          // client looks hung.
          this.trace?.note(`subnegotiation exceeded ${MAX_SUBNEG_BYTES} bytes, abandoned`);
          this.sb = [];
          this.state = St.Data;
        } else {
          this.sb.push(c);
        }
        return;

      case St.SbIac:
        if (c === T.SE) {
          this.handleSubnegotiation();
          this.state = St.Data;
        } else {
          this.sb.push(c);
          this.state = St.Sb;
        }
        return;
    }
  }

  /** Host asks us to enable an option. */
  private onDo(opt: number): void {
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
    if (this.sb[0] === O.TERMINAL_TYPE && this.sb[1] === S.SEND) {
      const name = Array.from(this.terminalType, (ch) => ch.charCodeAt(0));
      const out = Uint8Array.from([
        T.IAC, T.SB, O.TERMINAL_TYPE, S.IS, ...name, T.IAC, T.SE,
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

  private reply(cmd: number, opt: number): void {
    const bytes = Uint8Array.of(T.IAC, cmd, opt);
    this.trace?.send(bytes);
    this.write(bytes);
  }
}
