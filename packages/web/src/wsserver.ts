import type { Duplex } from 'node:stream';
import { parseFrame, serializeFrame, OPCODE } from './wsframe.js';

/**
 * The largest inbound message this gateway will accept.
 *
 * MEASURED against what a browser legitimately sends: the only inbound messages are a `hello`
 * (a kind and an optional session id) and an `action`, and `keys.ts:114` emits `type` ONE CHARACTER
 * at a time, so the real maximum is well under 100 bytes. 8 KB is roughly eighty times that, chosen
 * so that a future paste path -- a whole 43x80 screenful is 3440 characters -- still fits without a
 * protocol change, while nothing near the megabytes a hostile client would like is admitted.
 *
 * WHAT THE CAP IS FOR, and it is not merely tidiness: `protocol.ts` documents that a multi-megabyte
 * `{kind:'type', text:...}` is consumed synchronously by `Keyboard.typeString` on an unformatted
 * screen (VM/370's own logon panel is one), stalling the single-process event loop for every other
 * operator's session. The bound belongs on the frame because that covers every oversized field at
 * once instead of one bound per `Action` variant.
 */
export const MAX_MESSAGE_BYTES = 8192;

/**
 * A WebSocket connection over an already-upgraded socket.
 *
 * ## THIS IS THE SWAP-TO-`ws` SEAM
 *
 * Everything hand-rolled about the transport is behind this class and `wsframe.ts`. If the
 * hand-rolled framing ever disappoints, replacing this file with a `ws` wrapper that offers the
 * same four methods is the whole change -- nothing above it knows how a frame is shaped.
 *
 * ## A BAD CLIENT MUST NOT TAKE THE GATEWAY DOWN
 *
 * Framing errors are reported as a close, not thrown: a throw from a 'data' handler is an
 * unhandled exception that would end the process, so one malformed frame from one browser would
 * disconnect everybody else's mainframe session.
 */
export class Connection {
  // ANNOTATED, not inferred, and it does not compile without this. `Buffer.alloc(0)` infers the
  // narrow `Buffer<ArrayBuffer>`, while a socket chunk and `Buffer.concat` are both
  // `Buffer<ArrayBufferLike>` -- which admits `SharedArrayBuffer` and so is not assignable to it.
  // `vitest` does not typecheck, so this failed `npm run build` against a fully green suite.
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode = 0;
  private closed = false;
  private textHandler: (text: string) => void = () => {};
  private closeHandler: () => void = () => {};

  constructor(private readonly socket: Duplex) {
    socket.on('data', (chunk: Buffer) => { this.receive(chunk); });
    socket.on('close', () => { this.fireClose(); });
    socket.on('error', () => { this.fireClose(); });
  }

  onText(fn: (text: string) => void): void { this.textHandler = fn; }
  onClose(fn: () => void): void { this.closeHandler = fn; }

  sendBinary(payload: Buffer): void {
    if (this.closed) return;
    this.socket.write(serializeFrame(OPCODE.BINARY, payload));
  }

  close(): void {
    if (this.closed) return;
    this.socket.write(serializeFrame(OPCODE.CLOSE, Buffer.alloc(0)));
    this.socket.end();
    this.fireClose();
  }

  private fireClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler();
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      let frame;
      try {
        frame = parseFrame(this.buffer, MAX_MESSAGE_BYTES);
      } catch {
        // A protocol violation, or a frame over the cap. Close this client and keep the process up.
        this.close();
        return;
      }
      if (frame === undefined) return;                 // a partial frame: wait for more bytes
      this.buffer = this.buffer.subarray(frame.consumed);

      if (frame.opcode === OPCODE.CLOSE) { this.close(); return; }
      if (frame.opcode === OPCODE.PING) {
        this.socket.write(serializeFrame(OPCODE.PONG, frame.payload));
        continue;
      }
      if (frame.opcode === OPCODE.PONG) continue;

      if (!frame.fin) {
        if (this.fragments.length === 0) this.fragmentOpcode = frame.opcode;
        this.fragments.push(frame.payload);
        // THE CAP HAS TO BE CHECKED HERE TOO. Every fragment can be under the per-frame cap while
        // the message they build is not, so a client that sends 1 KB fragments and never a final
        // frame would grow this accumulator without limit -- the same exhaustion the per-frame cap
        // refuses, reached one legal frame at a time.
        this.fragmentBytes += frame.payload.length;
        if (this.fragmentBytes > MAX_MESSAGE_BYTES) { this.close(); return; }
        continue;
      }
      if (frame.opcode === OPCODE.CONTINUATION) {
        this.fragments.push(frame.payload);
        const whole = Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentBytes = 0;
        if (whole.length > MAX_MESSAGE_BYTES) { this.close(); return; }
        if (this.fragmentOpcode === OPCODE.TEXT) this.textHandler(whole.toString('utf8'));
        continue;
      }
      if (frame.opcode === OPCODE.TEXT) this.textHandler(frame.payload.toString('utf8'));
      // Binary from a client is unused: the only inbound messages are small JSON texts.
    }
  }
}
