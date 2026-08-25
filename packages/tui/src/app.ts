/**
 * The run loop: Session events in, ANSI out, keystrokes back.
 *
 * ## RAW MODE MUST BE RESTORED ON EVERY EXIT PATH
 *
 * Normal quit, Ctrl-], an uncaught exception, an unhandled rejection, SIGINT,
 * SIGTERM, SIGHUP. A terminal left in raw mode has no echo and no line editing,
 * and the user's only recovery is `stty sane` typed blind. `restore()` is
 * therefore idempotent and registered on all of those.
 *
 * Ctrl-C is deliberately NOT an interrupt: it is the Clear AID, which a 3270 user
 * needs constantly (it dismisses VM's MORE... state). Ctrl-] quits instead, and
 * the startup banner says so -- an undocumented escape hatch is no escape hatch.
 *
 * ## THE STREAMS AND THE PROCESS ARE INJECTED, NOT REACHED FOR
 *
 * `stdin`/`stdout`/`host` are narrow interfaces rather than `process` globals, so
 * the teardown rules above are unit-testable. That matters more here than
 * anywhere else in the codebase: "raw mode is restored on every exit path" is the
 * one requirement whose failure mode is a wrecked terminal, and a test that has
 * to spawn a real TTY to check it would not get written.
 */

import { AID, PA_AIDS, PF_AIDS, resolve, type Session } from '@tn3270/core';
import { detectDepth, type Depth } from './colours.js';
import { layout, TerminalRenderer, tooSmall } from './render.js';
import { lookup, MAX_SEQUENCE_LENGTH, PARTIAL, printableRun, type Action } from './keymap.js';

/** How long to wait before deciding a lone ESC really was Escape. */
const ESC_TIMEOUT_MS = 50;

/**
 * Make the cursor findable, and put it back afterwards.
 *
 * Two sequences because they degrade differently. DECSCUSR (`\x1b[2 q`, steady
 * block) is very widely implemented; OSC 12 (cursor colour) is BEST-EFFORT -- a
 * terminal that does not know it ignores it, which is why the shape is set too
 * rather than relying on colour alone.
 *
 * Green rather than white, matching the default-green foreground a 3279 shows and
 * the phosphor look people expect; it is one constant to change if white reads
 * better. The old default background was `neutral-black` at 0x1a1a1a -- a dark grey
 * -- against which an unstyled cursor was very hard to see. That default is now
 * pure black (core `resolve`), and the cursor is explicitly coloured.
 *
 * OSC 112 resets the colour to the terminal's own, and `\x1b[0 q` the shape, so a
 * user's carefully configured cursor survives running this.
 */
const CURSOR_ON = '\x1b]12;#00ff00\x07\x1b[2 q';
const CURSOR_OFF = '\x1b]112\x07\x1b[0 q';

export interface InputStream {
  setRawMode?(on: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
}

export interface OutputStream {
  write(text: string): unknown;
  readonly rows?: number | undefined;
  readonly columns?: number | undefined;
}

/** The bits of `process` this needs, so tests can supply their own. */
export interface HostProcess {
  on(event: string, listener: (arg?: unknown) => void): unknown;
  exit(code: number): void;
  stderr: { write(text: string): unknown };
}

export interface AppOptions {
  session: Session;
  stdin: InputStream;
  stdout: OutputStream;
  host: HostProcess;
  depth?: Depth;
  mode3279?: boolean;
  /**
   * The key-binding hint drawn above the screen when the terminal has a spare
   * row. Absent means draw none, which is what the tests want by default.
   */
  hint?: string;
}

export class App {
  private readonly session: Session;
  private readonly stdin: InputStream;
  private readonly stdout: OutputStream;
  private readonly host: HostProcess;
  private readonly renderer: TerminalRenderer;
  private readonly mode3279: boolean;
  private buffer: number[] = [];
  private escTimer: ReturnType<typeof setTimeout> | undefined;
  private restored = false;
  /** Last terminal size acted on, so a no-change SIGWINCH costs nothing. */
  private termRows = -1;
  private termCols = -1;
  /**
   * True while the terminal is too small to draw the screen.
   *
   * A live session cannot answer a mid-session shrink the way `start()` answers a
   * too-small launch -- throwing would abandon a connection the host thinks is
   * open. So painting STOPS instead, with a message saying why, and resumes when
   * the terminal grows back. Clipping to fit is deliberately not an option: the
   * 1920 cells are the host's data and silently hiding some of them is worse than
   * visibly refusing to draw.
   */
  private suspended = false;
  /**
   * Set once a quit is in flight.
   *
   * The plan left this field assigned and never read, and told the implementer to
   * either use it or delete it. It is USED, because deleting it leaves a real
   * bug: `host.exit()` does not stop the current turn (and in tests does not stop
   * anything at all), so a `screen` event that has already been queued can reach
   * `draw()` after `restore()` has left the alternate buffer -- painting 3270
   * cells over the user's shell prompt. Every write goes through this guard.
   */
  private quitting = false;

  constructor(opts: AppOptions) {
    this.session = opts.session;
    this.stdin = opts.stdin;
    this.stdout = opts.stdout;
    this.host = opts.host;
    this.mode3279 = opts.mode3279 ?? true;
    const screen = { rows: this.session.screen.rows, cols: this.session.screen.cols };
    this.renderer = new TerminalRenderer({
      ...screen,
      depth: opts.depth ?? detectDepth(),
      layout: layout(this.terminal(), screen),
      ...(opts.hint !== undefined ? { hint: opts.hint } : {}),
    });
  }

  /** The terminal's CURRENT size. Re-read every time, never cached. */
  private terminal(): { rows: number; cols: number } {
    return { rows: this.stdout.rows ?? 0, cols: this.stdout.columns ?? 0 };
  }

  /** Enter raw mode, register teardown, and start drawing. */
  start(): void {
    const term = this.terminal();
    const screen = { rows: this.session.screen.rows, cols: this.session.screen.cols };
    if (tooSmall(term, screen)) {
      // Refuse rather than draw a misleading partial screen -- the same choice
      // Transfer() makes when the geometry is wrong. Thrown BEFORE raw mode is
      // entered, so a refusal cannot itself wreck the terminal.
      throw new Error(
        `terminal is ${term.cols}x${term.rows}; the 3270 screen ` +
        `needs at least ${screen.cols}x${screen.rows}`,
      );
    }

    this.stdin.setRawMode?.(true);
    this.stdin.resume();
    this.stdout.write('\x1b[?1049h\x1b[2J');   // alternate screen buffer, cleared
    this.stdout.write(CURSOR_ON);

    // EVERY exit path. `restore` is idempotent.
    const bail = (err?: unknown): void => {
      this.restore();
      if (err !== undefined) this.host.stderr.write(`${String(err)}\n`);
      this.host.exit(err === undefined ? 0 : 1);
    };
    this.host.on('exit', () => this.restore());
    this.host.on('uncaughtException', bail);
    this.host.on('unhandledRejection', bail);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      this.host.on(sig, () => bail());
    }

    this.termRows = term.rows;
    this.termCols = term.cols;
    this.host.on('SIGWINCH', () => this.onResize());
    this.session.on('screen', () => this.draw());
    this.session.on('disconnect', () => { this.draw(); });
    this.stdin.on('data', (b: Uint8Array) => this.onInput(b));
    this.renderer.invalidate();
    this.draw();
  }

  /** Restore the terminal. Safe to call any number of times. */
  restore(): void {
    if (this.restored) return;
    this.restored = true;
    if (this.escTimer !== undefined) {
      // An armed ESC timer keeps the event loop alive after the terminal is
      // restored, so the process appears to hang for ESC_TIMEOUT_MS on exit.
      clearTimeout(this.escTimer);
      this.escTimer = undefined;
    }
    this.stdout.write(CURSOR_OFF);
    this.stdout.write('\x1b[?1049l');          // leave the alternate buffer
    this.stdin.setRawMode?.(false);
    this.stdin.pause();
  }

  /**
   * Re-measure after a terminal resize and repaint, suspend, or resume.
   *
   * The diff CANNOT survive a resize: every cursor address in the renderer's
   * remembered screen was computed against the old layout, so `setStatusRow`
   * invalidates whenever the OIA's home changes, and coming back from suspension
   * invalidates explicitly -- there the remembered screen may be unchanged while
   * the terminal has been overwritten by the too-small message.
   */
  private onResize(): void {
    if (this.quitting || this.restored) return;
    const term = this.terminal();
    if (term.rows === this.termRows && term.cols === this.termCols) return;
    this.termRows = term.rows;
    this.termCols = term.cols;

    const screen = { rows: this.session.screen.rows, cols: this.session.screen.cols };
    if (tooSmall(term, screen)) {
      this.suspended = true;
      this.stdout.write(
        `\x1b[2J\x1b[1;1Hterminal too small: the 3270 screen needs ` +
        `${screen.cols}x${screen.rows}, this terminal is ${term.cols}x${term.rows}. ` +
        `Resize to continue.`,
      );
      return;
    }

    const wasSuspended = this.suspended;
    this.suspended = false;
    this.renderer.setLayout(layout(term, screen));
    if (wasSuspended) this.renderer.invalidate();
    this.draw();
  }

  private draw(): void {
    // Nothing may be painted once the terminal has been handed back; see the
    // note on `quitting`. Nor while suspended -- see that field.
    if (this.quitting || this.restored || this.suspended) return;
    const cells = resolve(this.session.screen.snapshot(), { mode3279: this.mode3279 });
    const out = this.renderer.paint(cells, this.session.screen.cursor, this.session.oia.toText());
    if (out !== '') this.stdout.write(out);
  }

  /** Feed terminal bytes in. Public so a test needs no real TTY. */
  onInput(bytes: Uint8Array): void {
    for (const b of bytes) this.buffer.push(b);
    this.pump();
  }

  /**
   * Drain the buffer, acting on each complete sequence.
   *
   * ## THIS MATCHES A PREFIX, NOT THE WHOLE BUFFER, AND THAT IS A BUG FIX
   *
   * The plan called `lookup` on the entire buffer and discarded one byte whenever
   * it returned null. One `read` can carry several keystrokes -- type fast, or
   * press a key while an arrow is in flight -- so a buffer of `A\x1b[A` is
   * ordinary. `lookup("A\x1b[A")` is null (not a sequence, not all printable), so
   * the plan's loop SHIFTED THE `A` AWAY: a dropped keystroke, silent, and more
   * likely the faster the user types.
   *
   * So the front of the buffer is matched instead, preferring the LONGEST action:
   *
   * - A leading printable run is consumed whole, in one `typeString`. Scanning
   *   prefix by prefix would be O(n^2) on a paste, and one call per run also
   *   keeps insert-mode shifting to a single pass.
   * - Otherwise prefixes are tried up to the longest sequence in the table.
   *   PARTIAL means keep extending; an Action is remembered and extension
   *   continues in case a longer key also matches; null stops the scan.
   * - PARTIAL that reaches the end of the buffer means WAIT, and only then is
   *   the timer armed. A lone ESC is both a legal key and the prefix of every
   *   function key, and only elapsed time distinguishes them.
   */
  private pump(): void {
    if (this.escTimer !== undefined) {
      clearTimeout(this.escTimer);
      this.escTimer = undefined;
    }

    while (this.buffer.length > 0) {
      const bytes = Uint8Array.from(this.buffer);

      // A leading run of printable bytes is typed text, consumed in one go.
      const run = printableRun(bytes);
      if (run > 0) {
        const action = lookup(bytes.subarray(0, run));
        this.buffer.splice(0, run);
        if (action !== null && action !== PARTIAL) this.apply(action);
        continue;
      }

      let best: Action | undefined;
      let bestLen = 0;
      let stopped = 0;              // length at which the scan hit an impossible prefix
      const limit = Math.min(bytes.length, MAX_SEQUENCE_LENGTH);
      for (let len = 1; len <= limit; len++) {
        const r = lookup(bytes.subarray(0, len));
        if (r === PARTIAL) continue;
        if (r === null) { stopped = len; break; }
        best = r;
        bestLen = len;
      }

      if (best !== undefined) {
        this.buffer.splice(0, bestLen);
        this.apply(best);
        continue;
      }

      if (stopped > 0) {
        // The whole failed sequence goes, not one byte of it: leaving `[` of a
        // broken `\x1b[?` behind would type a literal bracket into the field.
        this.buffer.splice(0, stopped);
        continue;
      }

      // Every prefix was PARTIAL and the buffer is exhausted: wait for more.
      this.escTimer = setTimeout(() => {
        this.escTimer = undefined;
        // Timed out. The bytes are DISCARDED, not typed: on a 3270 a bare ESC has
        // no meaning of its own (PA1/PA2 are ESC-1/ESC-2), and an unfinished
        // sequence is not text the user asked to send. The plan's comment here
        // said "treat as literal" while its code discarded; the code was right.
        this.buffer = [];
      }, ESC_TIMEOUT_MS);
      return;
    }
  }

  /**
   * Perform one action.
   *
   * NOTE how thin this is: every branch delegates to `Keyboard` or `Session`.
   * The field-aware typing rules, the tab order, the keyboard lock and the AID
   * semantics all live in core and are already tested there. If a branch here
   * grows logic, that logic is in the wrong package.
   */
  private apply(action: Action): void {
    const k = this.session.keyboard;
    try {
      switch (action.kind) {
        case 'quit':
          this.quitting = true;
          this.restore();
          this.host.exit(0);
          return;                    // no draw: the terminal is no longer ours
        // `typeString` REPORTS refusal with false rather than throwing, so the
        // try/catch below would never see inhibited input. Nothing to do either
        // way: the OIA already says why, and the draw at the end shows it.
        case 'type': k.typeString(action.text); break;
        case 'enter': this.session.sendAID(AID.ENTER); break;
        case 'clear': this.session.sendAID(AID.CLEAR); break;
        case 'pf': this.session.sendAID(PF_AIDS[action.n - 1]!); break;
        case 'pa': this.session.sendAID(PA_AIDS[action.n - 1]!); break;
        case 'reset': k.reset(); break;
        case 'left': k.left(); break;
        case 'right': k.right(); break;
        case 'up': k.up(); break;
        case 'down': k.down(); break;
        case 'home': k.home(); break;
        case 'tab': k.tab(); break;
        case 'backTab': k.backTab(); break;
        case 'backspace': k.backspace(); break;
        case 'delete': k.deleteChar(); break;
        case 'eraseEOF': k.eraseEOF(); break;
        case 'eraseInput': k.eraseInput(); break;
      }
    } catch (err) {
      // A rejected action (not connected, program check) is normal operation,
      // not a crash. The OIA already says why, and draw() shows it.
      void err;
    }
    this.draw();
  }
}
