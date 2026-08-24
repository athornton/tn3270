import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve, Session, type Connection } from '@tn3270/core';
import { App, type HostProcess, type InputStream, type OutputStream } from '../src/app.js';

/**
 * A real `Session`, never a mock, with a fake socket.
 *
 * A fresh unconnected Session already accepts typing (measured: `typeString('A')`
 * returns true and lands in cell 0), so the input path can be asserted against
 * the REAL keyboard and screen. Mocking `Keyboard` here would only prove that
 * app.ts calls the method the test told it to expect.
 */
function makeSession(): Session {
  const conn: Connection = {
    write: () => {}, close: () => {},
    onData: undefined, onClose: undefined, onError: undefined,
  };
  return new Session({ connect: () => conn });
}

class FakeStdin implements InputStream {
  raw: boolean | undefined;
  rawCalls: boolean[] = [];
  resumed = 0;
  paused = 0;
  listener: ((chunk: Uint8Array) => void) | undefined;
  setRawMode(on: boolean): void { this.raw = on; this.rawCalls.push(on); }
  resume(): void { this.resumed++; }
  pause(): void { this.paused++; }
  on(_event: 'data', listener: (chunk: Uint8Array) => void): void { this.listener = listener; }
}

class FakeStdout implements OutputStream {
  written: string[] = [];
  constructor(public readonly rows = 25, public readonly columns = 80) {}
  write(text: string): void { this.written.push(text); }
  get all(): string { return this.written.join(''); }
}

class FakeHost implements HostProcess {
  handlers = new Map<string, ((arg?: unknown) => void)[]>();
  exits: number[] = [];
  errors: string[] = [];
  stderr = { write: (text: string) => { this.errors.push(text); } };
  on(event: string, listener: (arg?: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
  }
  exit(code: number): void { this.exits.push(code); }
  fire(event: string, arg?: unknown): void {
    for (const fn of this.handlers.get(event) ?? []) fn(arg);
  }
}

interface Harness {
  app: App; session: Session; stdin: FakeStdin; stdout: FakeStdout; host: FakeHost;
}

function harness(rows = 25, cols = 80): Harness {
  const session = makeSession();
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(rows, cols);
  const host = new FakeHost();
  const app = new App({ session, stdin, stdout, host, depth: 0 });
  return { app, session, stdin, stdout, host };
}

/** The resolved text of one cell, straight from the real screen. */
function cellText(session: Session, index: number): string {
  return resolve(session.screen.snapshot(), {})[index]!.text;
}

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';

describe('refusing a terminal that is too small', () => {
  it('throws rather than drawing a misleading partial screen', () => {
    const h = harness(24, 80);   // 24 rows: no room for the status line
    expect(() => h.app.start()).toThrow(/needs at least 80x25/);
  });

  it('does NOT enter raw mode or the alternate buffer when it refuses', () => {
    // The refusal must not itself wreck the terminal: if raw mode were entered
    // before the geometry check, a user who ran this in an 80x24 window would get
    // an exception AND a terminal with no echo, and the exception would be the
    // less serious half of that.
    const h = harness(24, 80);
    expect(() => h.app.start()).toThrow();
    expect(h.stdin.rawCalls).toEqual([]);
    expect(h.stdout.all).not.toContain(ALT_ON);
  });
});

describe('start', () => {
  it('enters raw mode, switches to the alternate buffer and draws', () => {
    const h = harness();
    h.app.start();
    expect(h.stdin.raw).toBe(true);
    expect(h.stdin.resumed).toBe(1);
    expect(h.stdout.all).toContain(ALT_ON);
    expect(h.stdout.all.length).toBeGreaterThan(ALT_ON.length);   // something drawn
  });

  it('wires a stdin data listener', () => {
    const h = harness();
    h.app.start();
    expect(h.stdin.listener).toBeTypeOf('function');
  });
});

describe('raw mode is restored on EVERY exit path', () => {
  // This is the one requirement in this package whose failure mode is a wrecked
  // terminal, recoverable only by typing `stty sane` blind. Each path is pinned
  // separately, because registering five of six is the likely defect and it
  // cannot be seen by using the program normally.
  const paths = ['exit', 'uncaughtException', 'unhandledRejection', 'SIGINT', 'SIGTERM', 'SIGHUP'];

  it('registers a handler for all six', () => {
    const h = harness();
    h.app.start();
    for (const p of paths) {
      expect(h.host.handlers.get(p)?.length ?? 0, p).toBeGreaterThan(0);
    }
  });

  it.each(paths)('restores the terminal when %s fires', (path) => {
    const h = harness();
    h.app.start();
    h.host.fire(path, path === 'exit' ? undefined : new Error('boom'));
    expect(h.stdin.raw, path).toBe(false);
    expect(h.stdout.all, path).toContain(ALT_OFF);
  });

  it('exits 0 on a signal and 1 on an exception, reporting the error', () => {
    const h1 = harness();
    h1.app.start();
    h1.host.fire('SIGINT');
    expect(h1.host.exits).toEqual([0]);

    const h2 = harness();
    h2.app.start();
    h2.host.fire('uncaughtException', new Error('boom'));
    expect(h2.host.exits).toEqual([1]);
    expect(h2.host.errors.join('')).toContain('boom');
  });

  it('is idempotent: two restores leave the alternate buffer once', () => {
    const h = harness();
    h.app.start();
    h.app.restore();
    h.app.restore();
    const leaves = h.stdout.all.split(ALT_OFF).length - 1;
    expect(leaves).toBe(1);
    expect(h.stdin.paused).toBe(1);
    expect(h.stdin.rawCalls).toEqual([true, false]);
  });
});

describe('quitting', () => {
  it('Ctrl-] restores the terminal and exits 0', () => {
    const h = harness();
    h.app.start();
    h.app.onInput(Uint8Array.from([0x1d]));
    expect(h.stdin.raw).toBe(false);
    expect(h.stdout.all).toContain(ALT_OFF);
    expect(h.host.exits).toEqual([0]);
  });

  it('paints NOTHING after quitting, even if a screen event arrives', () => {
    // host.exit() does not stop the current turn, and in a test it stops nothing
    // at all, so an already-queued screen event can reach draw() after the
    // terminal has been handed back. Painting 3270 cells over the user's shell
    // prompt is the visible symptom. This is what the `quitting` flag is for.
    const h = harness();
    h.app.start();
    h.app.onInput(Uint8Array.from([0x1d]));
    const after = h.stdout.written.length;
    h.session.keyboard.typeString('ZZZ');
    h.app.onInput(Uint8Array.from([0x41]));
    expect(h.stdout.written.length).toBe(after);
  });
});

describe('input dispatch', () => {
  it('types printable text into the real screen', () => {
    const h = harness();
    h.app.start();
    h.app.onInput(Uint8Array.from([0x41]));           // 'A'
    expect(cellText(h.session, 0)).toBe('A');
  });

  it('types a whole pasted run', () => {
    const h = harness();
    h.app.start();
    h.app.onInput(new TextEncoder().encode('HELLO'));
    expect([0, 1, 2, 3, 4].map((i) => cellText(h.session, i)).join('')).toBe('HELLO');
  });

  it('DOES NOT DROP a keystroke that shares a chunk with an escape sequence', () => {
    // The regression this whole pump was rewritten for. One read can carry
    // several keystrokes, so `A\x1b[A` is ordinary input -- type fast, or press a
    // key while an arrow is in flight. Matching the WHOLE buffer makes that null
    // (not a sequence, not all printable), and discarding a byte at a time then
    // throws the `A` away. Silent, and likelier the faster the user types.
    const h = harness();
    h.app.start();
    h.app.onInput(new TextEncoder().encode('A\x1b[A'));
    expect(cellText(h.session, 0)).toBe('A');         // the keystroke survived
    expect(h.session.screen.cursor).not.toBe(1);      // and the arrow was acted on
  });

  it('acts on both encodings of an arrow key', () => {
    for (const seq of ['\x1b[C', '\x1bOC']) {
      const h = harness();
      h.app.start();
      const before = h.session.screen.cursor;
      h.app.onInput(new TextEncoder().encode(seq));
      expect(h.session.screen.cursor, seq).toBe(before + 1);
    }
  });

  it('discards an impossible sequence WHOLE, without typing part of it', () => {
    // Leaving the `[` behind would type a literal bracket into the user's field.
    const h = harness();
    h.app.start();
    h.app.onInput(Uint8Array.from([0x1b, 0x5b, 0xff]));
    expect(cellText(h.session, 0)).toBe(' ');
    expect(h.session.screen.cursor).toBe(0);
  });

  it('survives an action the session cannot perform', () => {
    // Enter with no connection: sendAID throws, and that is normal operation, not
    // a crash. The OIA already says "X Disconnected".
    const h = harness();
    h.app.start();
    expect(() => h.app.onInput(Uint8Array.from([0x0d]))).not.toThrow();
    expect(h.session.oia.toText()).toContain('Disconnected');
  });
});

describe('the ambiguous Escape', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does nothing at all until the timer fires', () => {
    const h = harness();
    h.app.start();
    const before = h.stdout.written.length;
    h.app.onInput(Uint8Array.from([0x1b]));
    expect(h.stdout.written.length).toBe(before);     // no action taken
    vi.advanceTimersByTime(100);
    expect(cellText(h.session, 0)).toBe(' ');         // and never typed literally
  });

  it('completes the sequence when the rest arrives in time', () => {
    const h = harness();
    h.app.start();
    h.app.onInput(Uint8Array.from([0x1b]));
    h.app.onInput(new TextEncoder().encode('[C'));    // ESC then [C = right
    expect(h.session.screen.cursor).toBe(1);
  });

  it('clears an armed ESC timer on restore, so exit does not hang', () => {
    // A pending timer keeps the event loop alive, so the process would sit for
    // ESC_TIMEOUT_MS after the terminal was already restored.
    const h = harness();
    h.app.start();
    h.app.onInput(Uint8Array.from([0x1b]));
    expect(vi.getTimerCount()).toBe(1);
    h.app.restore();
    expect(vi.getTimerCount()).toBe(0);
  });
});
