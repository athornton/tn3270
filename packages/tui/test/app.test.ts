import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AID, resolve, Session, type Connection } from '@tn3270/core';
import type { Action } from '@tn3270/frontend';
import { App, type HostProcess, type InputStream, type OutputStream } from '../src/app.js';
import { overlayLines } from '../src/keypadOverlay.js';

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
  // Mutable, because a terminal resize is exactly a change to these two numbers
  // and App must re-read them rather than caching them at start().
  constructor(public rows = 25, public columns = 80) {}
  write(text: string): void { this.written.push(text); }
  get all(): string { return this.written.join(''); }
  resize(rows: number, columns: number): void { this.rows = rows; this.columns = columns; }
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

function harness(rows = 25, cols = 80, hint?: string): Harness {
  const session = makeSession();
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(rows, cols);
  const host = new FakeHost();
  const app = new App({ session, stdin, stdout, host, depth: 0, ...(hint !== undefined ? { hint } : {}) });
  return { app, session, stdin, stdout, host };
}

/** The resolved text of one cell, straight from the real screen. */
function cellText(session: Session, index: number): string {
  return resolve(session.screen.snapshot(), {})[index]!.text;
}

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';

describe('the minimum geometry, which now matches c3270', () => {
  it('RUNS in a terminal with no room for the OIA, rather than refusing', () => {
    // 80x24 is the commonest terminal size there is, and we used to refuse it. The
    // screen is mandatory, the OIA is not -- c3270/screen.c:895 drops the status
    // line the same way. This is the behaviour change the relaxed tooSmall exists
    // for, asserted at the App level because that is where a user meets it.
    const h = harness(24, 80);
    expect(() => h.app.start()).not.toThrow();
    expect(h.stdin.raw).toBe(true);
    expect(h.stdout.all).toContain(ALT_ON);
  });

  it('draws no status line when there is no room for one', () => {
    const h = harness(24, 80);
    h.app.start();
    expect(h.stdout.all).not.toContain('\x1b[25;1H');
  });

  it('still refuses a terminal that cannot hold the screen itself', () => {
    expect(() => harness(23, 80).app.start()).toThrow(/needs at least 80x24/);
    expect(() => harness(24, 79).app.start()).toThrow(/needs at least 80x24/);
  });

  it('does NOT enter raw mode or the alternate buffer when it refuses', () => {
    // The refusal must not itself wreck the terminal: if raw mode were entered
    // before the geometry check, a user in too small a window would get an
    // exception AND a terminal with no echo, and the exception would be the less
    // serious half of that.
    const h = harness(23, 80);
    expect(() => h.app.start()).toThrow();
    expect(h.stdin.rawCalls).toEqual([]);
    expect(h.stdout.all).not.toContain(ALT_ON);
  });
});

describe('centring, border and cursor', () => {
  it('centres the screen in a roomy terminal instead of hugging the corner', () => {
    // A JupyterLab terminal is essentially never 80x24, so this is the common case.
    const h = harness(40, 100);
    h.app.start();
    // 24-row screen + OIA + both borders + the hint = 28 in 40 rows -> 6 spare above,
    // +1 for the hint and +1 for the top border, so the screen's first row is row 9.
    expect(h.stdout.all).toContain('\x1b[9;11H');
    expect(h.stdout.all).not.toContain('\x1b[1;1H\x1b[');
  });

  it('draws the key-binding hint above the screen when a row is spare', () => {
    const h = harness(40, 100, 'tn3270: Ctrl-] quits');
    h.app.start();
    expect(h.stdout.all).toContain('Ctrl-] quits');
  });

  it('draws no hint in a terminal with no spare row for one', () => {
    // 26 rows takes the OIA and the bottom border and has nothing left, so the hint
    // has to come from main.ts's printed line instead.
    const h = harness(26, 100, 'tn3270: Ctrl-] quits');
    h.app.start();
    expect(h.stdout.all).not.toContain('Ctrl-] quits');
  });

  it('draws a border when there is room', () => {
    const h = harness(40, 100);
    h.app.start();
    expect(h.stdout.all).toContain('\u250c');   // top-left corner
    expect(h.stdout.all).toContain('\u2518');   // bottom-right corner
  });

  it('draws no border in a terminal that only fits the screen', () => {
    const h = harness(24, 80);
    h.app.start();
    expect(h.stdout.all).not.toContain('\u2500');
    expect(h.stdout.all).not.toContain('\u2502');
  });

  it('makes the cursor visible, and restores it on exit', () => {
    // A block cursor in a colour of its own; on the old dark-grey background the
    // cursor was effectively invisible. OSC 12 is best-effort -- a terminal that
    // does not implement it ignores the sequence -- so the shape is set too.
    const h = harness();
    h.app.start();
    expect(h.stdout.all).toContain('\x1b]12;');   // set cursor colour
    expect(h.stdout.all).toMatch(/\x1b\[\d q/);   // DECSCUSR shape
    const before = h.stdout.all;
    h.app.restore();
    const added = h.stdout.all.slice(before.length);
    expect(added).toContain('\x1b]112');          // reset cursor colour
    expect(added).toMatch(/\x1b\[0 q/);           // reset cursor shape
  });
});

describe('terminal resize (SIGWINCH)', () => {
  it('registers a SIGWINCH handler', () => {
    const h = harness();
    h.app.start();
    expect(h.host.handlers.get('SIGWINCH')?.length ?? 0).toBeGreaterThan(0);
  });

  it('repaints in full when the terminal grows', () => {
    // Every cursor address the diff remembers was computed for the old layout, so
    // a resize must invalidate rather than diff across it.
    const h = harness(24, 80);
    h.app.start();
    h.session.keyboard.typeString('AB');
    const before = h.stdout.written.length;
    h.stdout.resize(30, 80);
    h.host.fire('SIGWINCH');
    const emitted = h.stdout.written.slice(before).join('');
    expect(emitted).toContain('AB');            // full repaint, not an empty diff
    expect(emitted).toMatch(/\x1b\[\d+;\d+H\x1b\[0m/);   // and the OIA now has a home
  });

  it('stops painting and says why when the terminal shrinks below the screen', () => {
    const h = harness(30, 80);
    h.app.start();
    h.stdout.resize(20, 80);
    h.host.fire('SIGWINCH');
    expect(h.stdout.all.toLowerCase()).toContain('too small');
    const after = h.stdout.written.length;
    h.session.keyboard.typeString('XYZ');
    h.app.onInput(Uint8Array.from([0x41]));
    // Suspended: no 3270 cells may be painted into a terminal that cannot hold
    // them, because a clipped screen silently hides the host's data.
    expect(h.stdout.written.length).toBe(after);
  });

  it('resumes with a full repaint when the terminal grows back', () => {
    const h = harness(30, 80);
    h.app.start();
    h.session.keyboard.typeString('AB');
    h.stdout.resize(20, 80);
    h.host.fire('SIGWINCH');
    const before = h.stdout.written.length;
    h.stdout.resize(30, 80);
    h.host.fire('SIGWINCH');
    const emitted = h.stdout.written.slice(before).join('');
    expect(emitted).toContain('AB');
  });

  it('repaints on resume even when the 3270 screen did not change', () => {
    // Found by mutation: dropping `if (wasSuspended) invalidate()` left every test
    // green, because the earlier resume test happened to have a screen change to
    // emit. The requirement is independent of the 3270 screen -- the TERMINAL was
    // overwritten by the too-small message, so the remembered screen is a lie about
    // what the user can see, and only a full repaint fixes it.
    const h = harness(30, 80);
    h.app.start();
    h.session.keyboard.typeString('AB');
    h.app.onInput(Uint8Array.from([0x1b, 0x5b, 0x43]));   // right arrow, forces a draw
    h.stdout.resize(20, 80);
    h.host.fire('SIGWINCH');
    const before = h.stdout.written.length;
    h.stdout.resize(30, 80);                              // grow back, screen unchanged
    h.host.fire('SIGWINCH');
    expect(h.stdout.written.slice(before).join('')).toContain('AB');
  });

  it('does not repeat the too-small message on a spurious SIGWINCH', () => {
    // Also found by mutation: the no-change guard emits nothing either way while
    // RUNNING, so only the suspended case can pin it -- without the guard, every
    // spurious signal rewrites the message and clears the terminal again, which
    // flickers indefinitely on terminals that emit them freely.
    const h = harness(30, 80);
    h.app.start();
    h.stdout.resize(20, 80);
    h.host.fire('SIGWINCH');
    const after = h.stdout.written.length;
    h.host.fire('SIGWINCH');
    h.host.fire('SIGWINCH');
    expect(h.stdout.written.length).toBe(after);
  });

  it('ignores a SIGWINCH that did not actually change the size', () => {
    // Terminals emit these; a full repaint per spurious signal would flicker.
    const h = harness();
    h.app.start();
    const before = h.stdout.written.length;
    h.host.fire('SIGWINCH');
    expect(h.stdout.written.length).toBe(before);
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

  it('also clears an armed timer for a TRUNCATED sequence on restore', () => {
    // A SEPARATE setTimeout call site from the lone-ESC one above -- restore()
    // must clear whichever one happens to be pending, and this pins the other.
    const h = harness();
    h.app.start();
    h.app.onInput(new TextEncoder().encode('\x1b['));
    expect(vi.getTimerCount()).toBe(1);
    h.app.restore();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves Esc then 1 as PA1 however long the gap is', () => {
    // THE REPORTED BUG, 2026-09-14 from a Mac: ESC_TIMEOUT_MS is 50 and a human takes
    // hundreds of ms, so the ESC was discarded and the digit then arrived as ordinary text
    // -- `Esc 1` typed "1". No existing test could catch it: every keymap test hands
    // lookup() a complete `\x1b1`, which is exactly the case that already worked.
    const h = harness();
    h.app.start();
    const sent = vi.spyOn(h.session, 'sendAID');

    h.app.onInput(Uint8Array.from([0x1b]));
    vi.advanceTimersByTime(5000);                     // a hundred timeouts' worth
    h.app.onInput(Uint8Array.from([0x31]));           // '1'

    expect(sent).toHaveBeenCalledWith(AID.PA1);
    expect(cellText(h.session, 0)).toBe(' ');         // and NOT typed into the field
  });

  it('does not let a PROMOTED ESC combine with a paste into an arrow -- THE HAZARD', () => {
    // Found in review, 2026-09-15, one level up from the bug this file exists to fix.
    // GATED ON THE TIMEOUT HAVING FIRED: an earlier version of this fix held a lone
    // ESC with no timer at all, so it combined with WHATEVER arrived next regardless
    // of timing. That meant pasting text beginning `[A`/`[B`/`[C`/`[D`/`[H` right
    // after pressing Escape -- plausible on a Mac, where Option-as-Meta users reach
    // for both keys -- completed `\x1b[C` etc. as a genuine arrow match and silently
    // moved the cursor, landing the rest of the paste in the WRONG field. That is
    // SILENT CORRUPTION, and it is worse than the bug this file exists to fix.
    //
    // A paste arriving WITHIN the timeout is, correctly, a different story: see
    // 'completes the sequence when the rest arrives in time' above. This test is
    // about a paste arriving well after Escape, once the ESC has been promoted.
    const h = harness();
    h.app.start();
    h.app.onInput(Uint8Array.from([0x1b]));
    vi.advanceTimersByTime(100);                      // past ESC_TIMEOUT_MS: now PROMOTED
    h.app.onInput(new TextEncoder().encode('[C'));    // NOT a right-arrow

    // Typed literally, NOT consumed as a right-arrow, which would move the cursor
    // and type nothing.
    expect(cellText(h.session, 0)).toBe('[');
    expect(cellText(h.session, 1)).toBe('C');
    expect(h.session.screen.cursor).toBe(2);
  });

  it('types the byte after a PROMOTED ESC literally when it is not a PA digit', () => {
    // The improved cost, gated on the timeout having fired: once promoted, a bare
    // Escape with no PA follow-up is dropped and the buffer is reprocessed from the
    // start, so the very next keystroke is typed instead of lost. (Within the
    // timeout, an ESC followed by an unrelated byte is still discarded whole by the
    // ordinary impossible-sequence rule -- unchanged, and not what this pins.)
    const h = harness();
    h.app.start();
    h.app.onInput(Uint8Array.from([0x1b]));
    vi.advanceTimersByTime(100);                      // past ESC_TIMEOUT_MS: now PROMOTED
    h.app.onInput(new TextEncoder().encode('a'));
    expect(cellText(h.session, 0)).toBe('a');
  });

  it('still discards a TRUNCATED sequence after the timeout', () => {
    // The protection that must survive: `\x1b[` with nothing following is not a Meta prefix,
    // and leaving `[` behind would type a literal bracket into the field.
    const h = harness();
    h.app.start();
    h.app.onInput(new TextEncoder().encode('\x1b['));
    expect(vi.getTimerCount()).toBe(1);               // this one DOES arm a timer
    vi.advanceTimersByTime(100);
    h.app.onInput(new TextEncoder().encode('A'));

    // 'A' is typed as text, NOT resolved as a right-arrow from the stale `\x1b[` prefix.
    expect(cellText(h.session, 0)).toBe('A');
    expect(h.session.screen.cursor).not.toBe(0);
  });

  it('types a digit normally when no ESC came first', () => {
    // Duplicates coverage elsewhere in this file, deliberately: it is the paired
    // control for 'resolves Esc then 1 as PA1' above, proving the ESC-holding guard
    // above did not overreach into ordinary un-prefixed digits. Do not delete this as
    // redundant.
    const h = harness();
    h.app.start();
    const sent = vi.spyOn(h.session, 'sendAID');
    h.app.onInput(Uint8Array.from([0x31]));
    expect(sent).not.toHaveBeenCalled();
    expect(cellText(h.session, 0)).toBe('1');
  });
});

/**
 * Dispatch `toggleKeypad` as an Action, skipping the keymap.
 *
 * The interception was written BEFORE any byte produced this action, deliberately: `applyAction`
 * THROWS on it and `pump()` calls `apply()` unguarded, so binding the chord first would have killed
 * the process on a keystroke. That is why most tests below open the list by action rather than by
 * `0x0b`; every other key in them is a real byte, because arrows, Enter and Esc were already bound.
 *
 * Ctrl-K IS bound now, and 'OPENS on the Ctrl-K byte' below is the one test that goes through the
 * keymap. The rest keep using this on purpose: they are about the interception, and routing them
 * through the keymap as well would make each of them fail for two unrelated reasons.
 *
 * `apply` is private and reached by cast rather than widened for a test: `overlayOpen` below is the
 * one thing this feature adds to the public surface for testability, matching `onInput`.
 */
function dispatchToggle(app: App): void {
  (app as unknown as { apply(action: Action): void }).apply({ kind: 'toggleKeypad' });
}

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The selected line's text, exactly as the overlay renders it -- it begins with `>`. */
const marked = (selected: number): string => overlayLines(selected)[selected]!;

/**
 * Only the MOST RECENT write, so a growing `all` cannot satisfy an assertion about what the last
 * keystroke drew. One overlay keystroke is one `draw()`, so one write.
 */
const latest = (h: Harness): string => h.stdout.written[h.stdout.written.length - 1] ?? '';

describe('the special-keys overlay', () => {
  // The overlay holds a lone ESC for the same 50ms window `pump()` does, so closing it is a timed
  // event; see 'does not mistake an arrow key split across two reads for Escape' below.
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** Longer than ESC_TIMEOUT_MS, so a held lone ESC has resolved. */
  const AFTER_ESC = 60;

  it('opens on the toggle action and closes on Esc, without sending anything to the host', () => {
    const h = harness();
    h.app.start();
    const sent = vi.spyOn(h.session, 'sendAID');
    dispatchToggle(h.app);
    expect(h.app.overlayOpen).toBe(true);
    expect(h.stdout.all).toContain(marked(0));            // and it is actually drawn

    h.app.onInput(Uint8Array.from([0x1b]));
    vi.advanceTimersByTime(AFTER_ESC);
    expect(h.app.overlayOpen).toBe(false);
    expect(sent).not.toHaveBeenCalled();                  // nothing reached the host
    expect(cellText(h.session, 0)).toBe(' ');             // and nothing reached the screen
  });

  it('marks the selection in reverse video, inside the screen region and not the terminal corner', () => {
    // 40x100: the screen's top-left is terminal row 9, column 11 -- the same address 'centres the
    // screen in a roomy terminal' pins. Drawing at 1;1 instead would put the list outside the
    // border, over whatever the terminal had there.
    const h = harness(40, 100);
    h.app.start();
    dispatchToggle(h.app);
    expect(h.stdout.all).toContain(`\x1b[9;11H\x1b[0;7m${marked(0)}`);
  });

  it('fires the selected action on Enter and closes', () => {
    // Enter must fire the SELECTED key, not the Enter AID: while the overlay is up it belongs to
    // the overlay. Closing afterwards is what stops a second Enter re-firing it.
    for (const key of ['\r', '\n']) {
      const h = harness();
      h.app.start();
      const sent = vi.spyOn(h.session, 'sendAID');
      dispatchToggle(h.app);
      h.app.onInput(enc(key));

      expect(sent, key).toHaveBeenCalledWith(AID.PF13);     // KEYPAD_KEYS[0]
      expect(sent, key).not.toHaveBeenCalledWith(AID.ENTER);
      expect(h.app.overlayOpen, key).toBe(false);

      // The second Enter is the host's again, and does NOT re-fire the key.
      h.app.onInput(enc(key));
      expect(sent, key).toHaveBeenCalledWith(AID.ENTER);
      expect(sent.mock.calls.filter((c) => c[0] === AID.PF13), key).toHaveLength(1);
    }
  });

  it('moves the selection with either encoding of the arrow keys', () => {
    // ASSERTED AFTER EACH STEP, because the end state alone does not pin the DIRECTIONS: measured
    // by mutation, transposing the two handlers still lands 'down, down, up' on KEYPAD_KEYS[1] --
    // clamped twice at the top, then one step down -- so the obvious form of this test passed while
    // proving nothing. The first down is the assertion that cannot survive a swap.
    for (const [down, up] of [['\x1b[B', '\x1b[A'], ['\x1bOB', '\x1bOA']]) {
      const h = harness();
      h.app.start();
      const sent = vi.spyOn(h.session, 'sendAID');
      dispatchToggle(h.app);
      h.app.onInput(enc(down!));
      expect(latest(h), down).toContain(marked(1));
      h.app.onInput(enc(down!));
      expect(latest(h), down).toContain(marked(2));
      h.app.onInput(enc(up!));
      expect(latest(h), down).toContain(marked(1));
      h.app.onInput(enc('\r'));
      expect(sent, down).toHaveBeenCalledWith(AID.PF14);
    }
  });

  it('does NOT type into the screen while the overlay is up', () => {
    // The overlay owns the keyboard while open. A letter reaching the field would be a silent
    // corruption of whatever the operator was in the middle of typing.
    const h = harness();
    h.app.start();
    dispatchToggle(h.app);
    h.app.onInput(enc('A'));
    expect(cellText(h.session, 0)).toBe(' ');
    expect(h.session.screen.cursor).toBe(0);

    // The paired control: the keyboard comes BACK when the overlay closes, so the interception
    // cannot be a permanently swallowed keyboard.
    h.app.onInput(Uint8Array.from([0x1b]));
    vi.advanceTimersByTime(AFTER_ESC);
    h.app.onInput(enc('A'));
    expect(cellText(h.session, 0)).toBe('A');
  });

  it('does not mistake an arrow key split across two reads for Escape', () => {
    // THE REAL HAZARD IN THIS INTERCEPTION. `\x1b` and `[B` can arrive in separate reads -- that is
    // the delivery `pump()`'s escHeld comment records a regression for, so it is not hypothetical.
    // Closing on the first read would make the down arrow close the overlay on any terminal that
    // splits, which is a coin toss the user cannot see.
    const h = harness();
    h.app.start();
    const sent = vi.spyOn(h.session, 'sendAID');
    dispatchToggle(h.app);
    h.app.onInput(Uint8Array.from([0x1b]));
    expect(h.app.overlayOpen).toBe(true);               // held, not closed: it may be an arrow
    vi.advanceTimersByTime(10);                          // inside the window
    h.app.onInput(enc('[B'));
    expect(h.app.overlayOpen).toBe(true);
    h.app.onInput(enc('\r'));
    expect(sent).toHaveBeenCalledWith(AID.PF14);         // the split arrow moved the selection
  });

  it('closes on a lone ESC only once the window has passed, and never types it', () => {
    const h = harness();
    h.app.start();
    dispatchToggle(h.app);
    h.app.onInput(Uint8Array.from([0x1b]));
    vi.advanceTimersByTime(10);
    expect(h.app.overlayOpen).toBe(true);
    vi.advanceTimersByTime(AFTER_ESC);
    expect(h.app.overlayOpen).toBe(false);
    expect(cellText(h.session, 0)).toBe(' ');
  });

  it('acts on two arrows delivered in ONE read', () => {
    // A slow link or a busy event loop coalesces autorepeat, and a chunk-at-a-time matcher would
    // recognise neither -- the selection would silently stop moving while the key was held.
    const h = harness();
    h.app.start();
    const sent = vi.spyOn(h.session, 'sendAID');
    dispatchToggle(h.app);
    h.app.onInput(enc('\x1b[B\x1b[B'));
    h.app.onInput(enc('\r'));
    expect(sent).toHaveBeenCalledWith(AID.PF15);         // KEYPAD_KEYS[2], i.e. both arrows acted on
  });

  it('OPENS on the Ctrl-K byte, not just on the action, and sends nothing to the host', () => {
    // THE LOOP THE TASK ORDER OPENED, closed here. Every test above opens the list by dispatching
    // `toggleKeypad` directly, because when this interception was written no byte produced that
    // action -- `applyAction` throws on it and `pump()` calls `apply()` unguarded, so binding the
    // chord first would have killed the process on a keystroke. This is the only test that proves a
    // real keypress reaches the overlay: 0x0b gets there only because `keymap.ts` maps it, so
    // dropping that row reddens HERE and in `keymap.test.ts`, and nowhere else in this file.
    const h = harness();
    h.app.start();
    const sent = vi.spyOn(h.session, 'sendAID');
    h.app.onInput(Uint8Array.from([0x0b]));
    expect(h.app.overlayOpen).toBe(true);
    expect(h.stdout.all).toContain(marked(0));      // drawn, not merely flagged open
    expect(sent).not.toHaveBeenCalled();            // nothing reached the host
    expect(cellText(h.session, 0)).toBe(' ');       // and 0x0b was not typed into the field
  });

  it('closes on a second Ctrl-K', () => {
    // The chord is bound in `keymap.ts`, but this interception sits IN FRONT of the keymap, so it
    // has to handle the byte itself or it would swallow the very key that opened the list.
    const h = harness();
    h.app.start();
    dispatchToggle(h.app);
    h.app.onInput(Uint8Array.from([0x0b]));
    expect(h.app.overlayOpen).toBe(false);
  });

  it('hands back a keystroke that shared a read with the key that closed it', () => {
    // The overlay owns the keyboard only while it is UP. Bytes behind the closing key belong to the
    // screen, and swallowing them would be the silent dropped keystroke `pump()`'s docstring is
    // about -- likelier the faster the user types, and invisible when it happens.
    const h = harness();
    h.app.start();
    dispatchToggle(h.app);
    h.app.onInput(enc('\x0bA'));
    expect(h.app.overlayOpen).toBe(false);
    expect(cellText(h.session, 0)).toBe('A');
  });

  it('does not open while the session is suspended in a too-small terminal', () => {
    // 20x80 is suspended -- it cannot hold the 3270 screen -- but it CLEARS OVERLAY_MIN, so the
    // fits check does not cover this. `draw()` paints nothing while suspended, so opening would
    // leave a list that is invisible and yet owns the keyboard, and that appeared from nowhere when
    // the terminal grew back.
    const h = harness(30, 80);
    h.app.start();
    h.stdout.resize(20, 80);
    h.host.fire('SIGWINCH');
    const after = h.stdout.written.length;
    dispatchToggle(h.app);
    expect(h.app.overlayOpen).toBe(false);
    expect(h.stdout.written.length).toBe(after);   // and nothing painted over 'Resize to continue'
  });

  it('scrolls to keep the selection visible instead of showing only the first screenful', () => {
    // 46 keys and a 24-row screen: a first-N window would make every key from the 25th down
    // UNREACHABLE, which is a real limitation and not one to ship silently.
    const h = harness();
    h.app.start();
    dispatchToggle(h.app);
    for (let i = 0; i < 29; i++) h.app.onInput(enc('\x1b[B'));
    const before = h.stdout.written.length;
    h.app.onInput(enc('\x1b[B'));                        // the 30th, selecting KEYPAD_KEYS[30]
    const emitted = h.stdout.written.slice(before).join('');
    expect(emitted).toContain(marked(30));
    expect(emitted).not.toContain(overlayLines(30)[0]!);  // the top of the list has scrolled off
  });

  it('repaints the screen underneath when it closes, leaving no litter', () => {
    // The renderer's diff cannot see behind the overlay: the cells it remembers are the ones the
    // list is drawn over, so without an invalidation the list stays on screen after it closes.
    const h = harness();
    h.app.start();
    h.session.keyboard.typeString('AB');
    dispatchToggle(h.app);
    const before = h.stdout.written.length;
    h.app.onInput(Uint8Array.from([0x1b]));
    vi.advanceTimersByTime(AFTER_ESC);
    expect(h.stdout.written.slice(before).join('')).toContain('AB');
  });

  it('refuses to open in a terminal too small to hold it, and says so', () => {
    // THE ONLY WAY TO REACH THIS BRANCH. `overlayFits` cannot be false for a terminal a live
    // session is running in -- `tooSmall` already demands 24x80 and OVERLAY_MIN is 12x29 -- so this
    // shrinks the terminal WITHOUT delivering SIGWINCH, which is the genuine window between a
    // resize and its signal and the only geometry App re-reads live. OVERLAY_MIN is deliberately
    // NOT inflated to manufacture a refusal.
    const h = harness(30, 80);
    h.app.start();
    h.stdout.resize(10, 20);
    dispatchToggle(h.app);
    expect(h.app.overlayOpen).toBe(false);
    expect(h.stdout.all).not.toContain(marked(0));
    expect(h.stdout.all).toContain('too small');
    expect(h.stdout.all).toContain('special-keys');       // not the suspended-session message
  });

  it('leaves the ESC machinery untouched: no timer of its own outlives restore()', () => {
    // An armed timer keeps the event loop alive after the terminal is handed back, which is the
    // hang restore() already clears pump()'s two timers for. The overlay's hold is a third.
    const h = harness();
    h.app.start();
    dispatchToggle(h.app);
    h.app.onInput(Uint8Array.from([0x1b]));
    expect(vi.getTimerCount()).toBe(1);
    h.app.restore();
    expect(vi.getTimerCount()).toBe(0);
  });
});
