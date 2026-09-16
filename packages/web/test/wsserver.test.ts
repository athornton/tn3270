import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Connection, MAX_MESSAGE_BYTES } from '../src/wsserver.js';
import { OPCODE } from '../src/wsframe.js';

/**
 * `Connection` is the seam that would be replaced wholesale by the `ws` package. It owns exactly
 * one thing: turning a byte stream into messages and back. It must survive a TCP read boundary
 * falling anywhere, which is the failure a hand-rolled transport is most likely to have and the
 * one a local test will never hit by accident.
 *
 * ## WHY THIS IS NOT A `PassThrough`
 *
 * MEASURED, and it produced two false results before it was diagnosed: a single `PassThrough` is a
 * LOOPBACK. Its readable and writable halves are the same pipe, so (a) a `written` array collected
 * from `socket.on('data')` is a transcript of BOTH directions -- the ping test read back the
 * client's own PING and asserted opcode 9 against 10 -- and (b) every frame the server writes is
 * re-delivered to its own `receive()`, where it is correctly diagnosed as an unmasked client frame
 * and closes the connection. `sendBinary` observed `'payload' + 88 00`, that tail being the CLOSE
 * frame the server sent itself. A real socket's two directions are independent, so the fake must
 * keep them independent too or the harness tests a topology that cannot exist.
 *
 * `Connection` touches only `on`, `write` and `end`, so this is the whole contract.
 */
class FakeSocket extends EventEmitter {
  readonly written: Buffer[] = [];
  ended = false;

  write(buf: Buffer): boolean {
    this.written.push(buf);
    return true;
  }

  end(): void {
    this.ended = true;
  }

  /** Deliver bytes as if they had arrived from the client. Synchronous, so a throw would surface. */
  deliver(buf: Buffer): void {
    this.emit('data', buf);
  }
}

function clientFrame(opcode: number, payload: Buffer): Buffer {
  const key = Buffer.from([9, 8, 7, 6]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= key[i % 4]!;
  const head = payload.length < 126
    ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
    : (() => {
        const h = Buffer.alloc(4);
        h[0] = 0x80 | opcode;
        h[1] = 0x80 | 126;
        h.writeUInt16BE(payload.length, 2);
        return h;
      })();
  return Buffer.concat([head, key, masked]);
}

/**
 * Just the 10 header bytes of a frame that DECLARES `len` bytes -- no masking key, no payload.
 *
 * The masking key is deliberately absent: with it appended, this same test passed against a cap
 * checked LATE, because the four extra bytes satisfied the parser's mask-key wait and the late
 * check still threw. Ten bytes is the earliest point at which the declared length is known, so it
 * is the only length that makes a later check fail.
 */
function clientFrameHeaderDeclaring(len: number): Buffer {
  const h = Buffer.alloc(10);
  h[0] = 0x80 | OPCODE.TEXT;
  h[1] = 0x80 | 127;
  h.writeBigUInt64BE(BigInt(len), 2);
  return h;
}

/** Server frames are unmasked, so the shared parser (which demands a mask) cannot read them. */
function parseFrameFromServer(buf: Buffer): { opcode: number; payload: Buffer } {
  const opcode = buf[0]! & 0x0f;
  let len = buf[1]! & 0x7f;
  let off = 2;
  if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
  return { opcode, payload: buf.subarray(off, off + len) };
}

const setup = () => {
  const socket = new FakeSocket();
  const conn = new Connection(socket as never);
  return { socket, written: socket.written, conn };
};

describe('Connection', () => {
  it('delivers a whole text message', () => {
    const { socket, conn } = setup();
    const seen: string[] = [];
    conn.onText((t) => seen.push(t));
    socket.deliver(clientFrame(OPCODE.TEXT, Buffer.from('{"kind":"hello"}')));
    expect(seen).toEqual(['{"kind":"hello"}']);
  });

  it('delivers a message split across reads, byte by byte', () => {
    // The property that matters: a TCP boundary can fall anywhere, including inside the header or
    // the masking key. Feeding one byte at a time exercises every split at once.
    const { socket, conn } = setup();
    const seen: string[] = [];
    conn.onText((t) => seen.push(t));
    const frame = clientFrame(OPCODE.TEXT, Buffer.from('x'.repeat(300)));
    for (const byte of frame) socket.deliver(Buffer.from([byte]));
    expect(seen).toEqual(['x'.repeat(300)]);
  });

  it('delivers two messages arriving in one read', () => {
    const { socket, conn } = setup();
    const seen: string[] = [];
    conn.onText((t) => seen.push(t));
    socket.deliver(Buffer.concat([
      clientFrame(OPCODE.TEXT, Buffer.from('one')),
      clientFrame(OPCODE.TEXT, Buffer.from('two')),
    ]));
    expect(seen).toEqual(['one', 'two']);
  });

  it('reassembles a fragmented message', () => {
    const { socket, conn } = setup();
    const seen: string[] = [];
    conn.onText((t) => seen.push(t));
    // FIN=0 TEXT then FIN=1 CONTINUATION.
    const first = clientFrame(OPCODE.TEXT, Buffer.from('par'));
    first[0] = OPCODE.TEXT;                       // clear FIN
    socket.deliver(first);
    socket.deliver(clientFrame(OPCODE.CONTINUATION, Buffer.from('tial')));
    expect(seen).toEqual(['partial']);
  });

  it('answers a ping with a pong carrying the same payload', () => {
    const { socket, written, conn } = setup();
    conn.onText(() => {});
    socket.deliver(clientFrame(OPCODE.PING, Buffer.from('beat')));
    const out = parseFrameFromServer(Buffer.concat(written));
    expect(out.opcode).toBe(OPCODE.PONG);
    expect(out.payload.toString()).toBe('beat');
  });

  it('ignores a pong without treating it as a message', () => {
    const { socket, written, conn } = setup();
    conn.onText(() => { throw new Error('a pong is not a message'); });
    socket.deliver(clientFrame(OPCODE.PONG, Buffer.from('beat')));
    expect(written).toEqual([]);
  });

  it('reports a close, once, and stops delivering afterwards', () => {
    const { socket, conn } = setup();
    const closed = vi.fn();
    conn.onClose(closed);
    conn.onText(() => { throw new Error('must not be called after close'); });
    socket.deliver(clientFrame(OPCODE.CLOSE, Buffer.alloc(0)));
    socket.deliver(clientFrame(OPCODE.TEXT, Buffer.from('late')));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(socket.ended).toBe(true);
  });

  it('reports a socket error as a close', () => {
    // Node emits 'error' on a socket reset, and an unhandled 'error' on an EventEmitter THROWS.
    const { socket, conn } = setup();
    const closed = vi.fn();
    conn.onClose(closed);
    expect(() => socket.emit('error', new Error('ECONNRESET'))).not.toThrow();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('sendBinary writes an UNMASKED binary frame', () => {
    const { written, conn } = setup();
    conn.sendBinary(Buffer.from('payload'));
    const out = Buffer.concat(written);
    expect(out[0]).toBe(0x80 | OPCODE.BINARY);
    expect(out[1]! & 0x80).toBe(0);
    expect(out.subarray(2).toString()).toBe('payload');
  });

  it('sendBinary after a close writes nothing', () => {
    const { socket, written, conn } = setup();
    socket.deliver(clientFrame(OPCODE.CLOSE, Buffer.alloc(0)));
    written.length = 0;
    conn.sendBinary(Buffer.from('payload'));
    expect(written).toEqual([]);
  });

  it('reports a framing error as a close rather than throwing into the event loop', () => {
    // An unmasked client frame is a protocol violation. Throwing from a 'data' handler would be an
    // unhandled exception that takes the whole gateway down -- one bad client must not do that.
    const { socket, conn } = setup();
    const closed = vi.fn();
    conn.onClose(closed);
    conn.onText(() => {});
    expect(() => socket.deliver(Buffer.concat([
      Buffer.from([0x80 | OPCODE.TEXT, 5]), Buffer.from('hello'),
    ]))).not.toThrow();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  describe('the frame size cap', () => {
    it('accepts a message at the cap', () => {
      const { socket, conn } = setup();
      const seen: string[] = [];
      conn.onText((t) => seen.push(t));
      socket.deliver(clientFrame(OPCODE.TEXT, Buffer.alloc(MAX_MESSAGE_BYTES, 0x61)));
      expect(seen).toEqual(['a'.repeat(MAX_MESSAGE_BYTES)]);
    });

    it('closes on a frame one byte over the cap', () => {
      const { socket, conn } = setup();
      const closed = vi.fn();
      conn.onClose(closed);
      conn.onText(() => { throw new Error('an oversized frame must not be delivered'); });
      socket.deliver(clientFrame(OPCODE.TEXT, Buffer.alloc(MAX_MESSAGE_BYTES + 1, 0x61)));
      expect(closed).toHaveBeenCalledTimes(1);
    });

    it('refuses an oversized DECLARED length before the payload arrives', () => {
      // The property that makes the cap worth having. A frame declaring 4 GB must be refused on the
      // first read, from its header alone -- not buffered until the payload it promised shows up,
      // which is exactly the memory exhaustion the cap exists to prevent.
      const { socket, conn } = setup();
      const closed = vi.fn();
      conn.onClose(closed);
      const header = clientFrameHeaderDeclaring(4 * 1024 * 1024 * 1024);
      expect(header.length).toBe(10);
      socket.deliver(header);
      expect(closed).toHaveBeenCalledTimes(1);
    });

    it('bounds a message reassembled from many small fragments', () => {
      // Each fragment is legal on its own, so a per-frame cap alone leaves the accumulator
      // unbounded: enough 1 KB fragments with FIN=0 and never a final frame is the same memory
      // exhaustion by another route.
      const { socket, conn } = setup();
      const closed = vi.fn();
      conn.onClose(closed);
      conn.onText(() => { throw new Error('an oversized message must not be delivered'); });
      const fragment = clientFrame(OPCODE.TEXT, Buffer.alloc(1024, 0x61));
      fragment[0] = OPCODE.TEXT;                  // clear FIN: a fragment, never a final frame
      const enough = Math.ceil(MAX_MESSAGE_BYTES / 1024) + 1;
      for (let i = 0; i < enough; i += 1) socket.deliver(fragment);
      expect(closed).toHaveBeenCalledTimes(1);
    });
  });
});
