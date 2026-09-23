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

import { resolve, type Session } from '@tn3270/core';
import { detectDepth, type Depth } from './colours.js';
import { moveSelection, overlayFits, overlayLines, selectedAction } from './keypadOverlay.js';
import { layout, TerminalRenderer, tooSmall } from './render.js';
import { transferFits, transferLines, type TransferPhase } from './transferOverlay.js';
import {
  applyAction, lookup, MAX_SEQUENCE_LENGTH, PARTIAL, printableRun, resolveScheme,
  cycleField, moveField, newTransferForm, setFieldText, TRANSFER_FIELDS,
  type Action, type Scheme, type TransferFormState, type TransferValues,
} from '@tn3270/frontend';

/** The byte a lone Escape keypress sends; also the first byte of every function key. */
const ESC = 0x1b;

/**
 * The bytes the special-keys overlay reads while it is open, and nowhere else.
 *
 * Compared as BYTES rather than as a decoded string: a chunk can carry more than one keystroke, and
 * `seq === '\r'` on the whole chunk answers "was this read exactly one Return", which is a
 * different question from "does the next key begin with Return". See `overlayKey`.
 */
const OVERLAY_CR = 0x0d;
const OVERLAY_LF = 0x0a;
const OVERLAY_TOGGLE = 0x0b;      // Ctrl-K, which the terminal keymap maps to `toggleKeypad`
const OVERLAY_CSI = 0x5b;         // the `[` of `\x1b[A`
const OVERLAY_SS3 = 0x4f;         // the `O` of `\x1bOA`, which DECCKM makes equally likely
const OVERLAY_UP = 0x41;
const OVERLAY_DOWN = 0x42;

/**
 * The bytes the TRANSFER FORM reads while it is open, beside the `OVERLAY_*` ones it reuses.
 *
 * `OVERLAY_CR`/`LF`/`CSI`/`SS3`/`UP`/`DOWN`/`TOGGLE` and `ESC` are shared rather than redefined:
 * two constants for one byte is exactly the drift this codebase keeps eliminating.
 */
const TRANSFER_TOGGLE = 0x14;     // Ctrl-T, which the terminal keymap maps to `transferForm`
const TAB = 0x09;
/**
 * BOTH backspace bytes, because terminals disagree about which one the key sends.
 *
 * `0x7f` is DEL and what most Unix terminals send; `0x08` is Ctrl-H and what some others do. The
 * keymap takes `0x7f` for its own `backspace`, so accepting only that here would leave the key
 * dead for anyone whose terminal sends the other.
 */
const BACKSPACE = 0x08;
const DEL = 0x7f;
const TRANSFER_RIGHT = 0x43;      // the `C` of `\x1b[C`
const TRANSFER_LEFT = 0x44;       // the `D` of `\x1b[D`
const TRANSFER_BACKTAB = 0x5a;    // the `Z` of `\x1b[Z`

/**
 * `k`/`w` for up and `j`/`s` for down, as alternatives to the arrows -- ONLY while the list is open.
 *
 * A BARE LETTER IS BINDABLE NOWHERE ELSE IN THIS EMULATOR. Letters are data the operator types into
 * fields; `pump()` hands every printable run to `typeString`. It is safe here for exactly one
 * reason: the interception in `onInput` gives the overlay the whole keyboard and `overlayKey`
 * already swallows every byte it does not recognise, so these letters replace a no-op rather than
 * displacing anything. Nothing about this generalises past `overlayShown`.
 *
 * NO `h`, `l`, `a` OR `d`, on purpose, and they are NOT an oversight: the overlay is a
 * single-column scrolling list of all 47 `KEYPAD_KEYS`, so there is no left or right to move in.
 * They stay swallowed like any other letter. Giving them an invented meaning -- page up, jump to
 * the end -- would be a binding the user cannot guess from the list on screen and cannot undo.
 *
 * CASE-FOLDED, so `K` moves up as well as `k`. This DIVERGES FROM VI, where `K` is a different
 * command from `k`; the reason is the same one the `CTRL` table in canvas/src/keys.ts case-folds
 * for (Ctrl-Shift-C is still Clear) -- caps lock, or a held shift, must not silently make the
 * list unnavigable. There is nothing for a shifted form to mean here, so nothing is given up.
 */
const OVERLAY_UP_LETTERS: ReadonlySet<number> = new Set(Array.from('kKwW', (c) => c.charCodeAt(0)));
const OVERLAY_DOWN_LETTERS: ReadonlySet<number> = new Set(Array.from('jJsS', (c) => c.charCodeAt(0)));

/** -1, 1, or 0 for a byte that is not one of the letters above. `undefined` cannot be a member. */
function overlayLetterDelta(byte: number | undefined): number {
  if (byte === undefined) return 0;
  if (OVERLAY_UP_LETTERS.has(byte)) return -1;
  if (OVERLAY_DOWN_LETTERS.has(byte)) return 1;
  return 0;
}

/**
 * How long to wait before giving up on an unresolved escape path -- either a
 * lone ESC that might still be the start of a function key, or a multi-byte
 * sequence like `\x1b[` that started down one and stalled. The two do
 * DIFFERENT things on expiry: a lone ESC is PROMOTED to a Meta prefix (see
 * `escHeld`), a truncated sequence is discarded. Both get the same window
 * because both mean "no more bytes arrived from what a terminal would have
 * sent as one burst" -- see the regression note at the bottom of `pump()`
 * for why a lone ESC cannot skip this wait and be held immediately instead.
 *
 * ANY fixed timeout leaves a boundary, and this one is worth stating rather than
 * discovering: a function key genuinely split with an inter-byte gap NEAR 50ms
 * resolves as the key when the gap lands under, and types its bytes literally
 * when it lands over. That is inherent to disambiguating a byte which is both a
 * legal keypress and a prefix, and it is unavoidable at some threshold. What
 * matters is that it FAILS SAFE: a promoted ESC that does not complete a PA is
 * dropped and the remainder re-enters the ordinary scan as text, so the boundary
 * costs a literal `[C` on screen, never a cursor move the user did not ask for.
 * The pre-2026-09-15 discard scheme had the same boundary and a worse failure --
 * it lost the following keystroke entirely.
 */
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
  /** Which palette to draw. Absent means the readable default. */
  scheme?: Scheme;
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
  /**
   * True once a held lone ESC's timer has FIRED, promoting it to a Meta prefix,
   * until the next `pump()` call resolves it. Before the timer fires, more
   * bytes arriving clear it (at the top of `pump()`) and resolve through the
   * ordinary full-table scan instead -- exactly as they did before this
   * ESC-holding behaviour existed -- so a split function key delivered
   * promptly still completes normally. Only a PROMOTED ESC is narrowed to
   * PA-only completion.
   */
  private escHeld = false;
  private restored = false;
  /** Last terminal size acted on, so a no-change SIGWINCH costs nothing. */
  private termRows = -1;
  /**
   * The SCREEN size last drawn, so an Erase/Write Alternate that actually changed
   * it can be told apart from the many ordinary screen events that did not.
   */
  private screenRows = -1;
  private screenCols = -1;
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
  /** Which of the 47 keys the overlay's `>` marks. */
  private overlaySelected = 0;
  private overlayShown = false;
  /**
   * The first line of the 47 currently in the window, moved only when the selection would leave
   * it -- see `overlayWindow`.
   */
  private overlayTop = 0;
  /**
   * An escape prefix the overlay has read but cannot yet resolve, with its own timer.
   *
   * SEPARATE FROM `buffer` AND `escHeld` ON PURPOSE. Those two are the most delicate thing in this
   * file and the interception exists so that nothing the overlay does can perturb them; see
   * `consumeOverlayKey` for why a prefix has to be held at all.
   */
  private overlayPending: number[] = [];
  private overlayTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * The transfer form's state, MUTUALLY EXCLUSIVE with the overlay's above.
   *
   * A separate set of fields rather than a shared "which overlay" enum, following how the two
   * renderers are separate: the keypad list carries a selection and a scroll window over 47 fixed
   * rows, and the form carries values whose applicability changes what rows exist at all. The one
   * invariant between them is that `transferShown` and `overlayShown` are never both true, which
   * `toggleTransfer`/`toggleOverlay` maintain and `app.test.ts` pins.
   *
   * `transferPending`/`transferTimer` are separate from BOTH `buffer`/`escHeld` and the overlay's
   * pair, for the reason `overlayPending` gives: the ESC state machine in `pump()` is the most
   * delicate thing in this file and nothing an overlay does may perturb it.
   */
  private transferShown = false;
  private transferState: TransferFormState = newTransferForm();
  private transferPhase: TransferPhase = 'idle';
  private transferProgress: string | undefined;
  private transferPending: number[] = [];
  private transferTimer: ReturnType<typeof setTimeout> | undefined;

  /** Public for tests, like `onInput`: a test should not have to infer this from bytes. */
  get overlayOpen(): boolean { return this.overlayShown; }

  /** Public for tests, like `overlayOpen`. */
  get transferOpen(): boolean { return this.transferShown; }

  /** For tests: the form's current values. */
  get transferValues(): TransferValues { return this.transferState.values; }

  /** For tests: which entry of `TRANSFER_FIELDS` is selected. */
  get transferSelected(): number { return this.transferState.selected; }

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
      scheme: opts.scheme ?? resolveScheme(),
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
    // A screen event may carry a size change (Erase/Write Alternate), so the
    // geometry check comes first. It is a cheap comparison that returns
    // immediately in the overwhelmingly common case of an unchanged size, and on
    // a model 2 it can never fire at all.
    this.session.on('screen', () => { this.onScreenResize(); this.draw(); });
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
    // A promoted ESC left in `buffer` is harmless once restored -- `stdin.pause()`
    // below stops any further `onInput`, so nothing will ever resume it -- but
    // clear the flag anyway rather than leave a stale "waiting to resolve"
    // state on an App that should be fully torn down.
    this.escHeld = false;
    // The overlay's own held prefix is a THIRD timer, and it keeps the event loop alive after the
    // terminal is restored exactly as the two above do. The transfer form's is a FOURTH -- every
    // `setTimeout` call site in this file has to be represented here, which is why they are listed
    // rather than folded into one helper: a new one is then a visibly missing line.
    this.clearOverlayTimer();
    this.overlayPending = [];
    this.clearTransferTimer();
    this.transferPending = [];
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
    this.replace(term);
  }

  /**
   * The 3270 SCREEN changed size, because the host sent Erase/Write Alternate.
   *
   * Separate entry point from `onResize` but the same body: from the renderer's
   * point of view a 24x80 screen becoming 43x80 needs exactly what a terminal
   * resize needs -- re-place, re-shape, repaint, and suspend if the window can no
   * longer hold it. Nothing here is TN3270E; see execute.ts on EW/EWA.
   */
  private onScreenResize(): void {
    if (this.quitting || this.restored) return;
    const s = this.session.screen;
    if (s.rows === this.screenRows && s.cols === this.screenCols) return;
    this.replace(this.terminal());
  }

  /** Shared body: re-place everything for the current terminal and screen. */
  private replace(term: { rows: number; cols: number }): void {
    const screen = { rows: this.session.screen.rows, cols: this.session.screen.cols };
    this.screenRows = screen.rows;
    this.screenCols = screen.cols;
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
    // Order matters: the renderer must know the new SCREEN shape before it is
    // given a layout computed from it, or the first paint clips against the old
    // one.
    this.renderer.setScreenSize(screen.rows, screen.cols);
    this.renderer.setLayout(layout(term, screen));
    if (wasSuspended) this.renderer.invalidate();
    this.draw();
  }

  private draw(): void {
    // Nothing may be painted once the terminal has been handed back; see the
    // note on `quitting`. Nor while suspended -- see that field.
    if (this.quitting || this.restored || this.suspended) return;
    const cells = resolve(this.session.screen.snapshot(), { mode3279: this.mode3279 });
    const out = this.renderer.paint(
      cells, this.session.screen.cursor, this.session.oia.toText(),
      // At most one contributes: the two are mutually exclusive, so the order of this chain is
      // a tie-break that can never be needed rather than a precedence rule.
      this.overlayShown ? this.overlayWindow()
        : this.transferShown
          ? transferLines(this.transferState, this.transferPhase, this.transferProgress)
          : undefined,
    );
    if (out !== '') this.stdout.write(out);
  }

  /** Feed terminal bytes in. Public so a test needs no real TTY. */
  onInput(bytes: Uint8Array): void {
    // WHILE THE OVERLAY IS OPEN IT OWNS THE KEYBOARD. Falling through to `pump` would type letters
    // into the field behind it, silently corrupting whatever was half-entered -- and it would send
    // AIDs to the host from a list the operator was only reading.
    //
    // BEFORE the buffer and before `pump`, deliberately: the ESC state machine below is untouched
    // by anything the overlay does, and the overlay does not have to reason about `escHeld`.
    if (this.overlayShown) { this.consumeOverlayKey(bytes); return; }
    // THE FORM OWNS THE KEYBOARD FOR THE SAME REASONS AND ONE MORE: it has TEXT FIELDS, and a
    // filename needs every printable character. A bare letter is bindable nowhere else in this
    // emulator precisely because `pump()` hands printable runs to `typeString`; this interception
    // is what makes typing a path possible at all. It also stops Enter reaching the host as an
    // AID when the operator meant to submit the form.
    if (this.transferShown) { this.consumeTransferKey(bytes); return; }
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
   * - PARTIAL that reaches the end of the buffer means WAIT, and the timer is
   *   armed. A lone ESC is both a legal key and the prefix of every function
   *   key, and it cannot be resolved from the buffer alone -- so it gets the
   *   same timer as an unfinished multi-byte sequence, but a different action
   *   on expiry (promoted, not discarded). See `escHeld` below.
   */
  private pump(): void {
    if (this.escTimer !== undefined) {
      clearTimeout(this.escTimer);
      this.escTimer = undefined;
    }

    while (this.buffer.length > 0) {
      const bytes = Uint8Array.from(this.buffer);

      // Resume a PROMOTED lone ESC -- its timer already fired (see the bottom
      // of this function), which is why `escHeld` is true rather than having
      // just been set. `onInput` always appends at least one byte before
      // calling `pump()`, so `bytes.length` is at least 2 here.
      //
      // A promoted ESC combines with ONLY the next byte, and ONLY to complete a
      // PA (`\x1b1`/`\x1b2`/`\x1b3`) -- the one thing a human can genuinely type
      // as two separate keystrokes, slowly enough to cross ESC_TIMEOUT_MS. A
      // split function key (CSI/SS3, e.g. `\x1b[A`) delivered WITHIN the
      // timeout never reaches this branch at all: its second half arrives
      // before the timer fires, clearing it (top of `pump()`), and the WHOLE
      // sequence resolves through the ordinary scan below on that same call --
      // so promptly-split arrows and function keys are unaffected. So anything
      // other than a completed PA here means the ESC really was just Escape,
      // followed seconds later by something unrelated; the ESC is dropped and
      // the rest of the buffer is reprocessed from the start.
      //
      // THE HAZARD THIS CLOSES (found in review, 2026-09-15): without this
      // narrowing, a promoted ESC combined with WHATEVER arrived next, so a
      // paste beginning `[A`/`[B`/`[C`/`[D`/`[H` -- typed well after
      // ESC_TIMEOUT_MS, since it is its own separate keystroke -- completed
      // `\x1b[A` etc. as a genuine arrow/Home match two blocks down, silently
      // moving the cursor and landing the rest of the paste in the WRONG
      // field. Narrowing to PA-only means that paste is typed literally.
      if (this.escHeld) {
        this.escHeld = false;
        const pa = lookup(bytes.subarray(0, 2));
        if (pa !== null && pa !== PARTIAL) {
          this.buffer.splice(0, 2);
          this.apply(pa);
          continue;
        }
        this.buffer.splice(0, 1);
        continue;
      }

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
      //
      // A LONE ESC ARMS THE SAME TIMER AS AN UNFINISHED SEQUENCE, BUT IS PROMOTED
      // ON EXPIRY, NOT DISCARDED. PA1/PA2/PA3 are ESC-1/2/3 -- Escape then a digit
      // -- and a human pressing them takes hundreds of milliseconds, well past
      // ESC_TIMEOUT_MS, so discarding on expiry meant the PA keys only ever
      // worked when a terminal sent `\x1b1` as ONE burst, i.e. via
      // Option-as-Meta. Reported from a Mac 2026-09-14: `Esc 1` typed the digit.
      //
      // REGRESSION FOUND IN REVIEW, 2026-09-15, and why this timer is still here:
      // an earlier version of this fix held a lone ESC with NO timer at all, so
      // the very NEXT pump() call took the PA-only path unconditionally -- even
      // one millisecond later, even for a split function key that would have
      // completed fine before this file ever changed. That is a regression
      // against what shipped before this fix existed. Arming the timer here
      // means a promptly-delivered second half still clears it (top of this
      // function) and resolves through the ordinary scan above, exactly as it
      // always did; only a gap that actually EXCEEDS ESC_TIMEOUT_MS promotes the
      // ESC to a Meta prefix, at which point the `escHeld` branch above narrows
      // what it can combine with -- see the hazard comment there.
      if (bytes.length === 1 && bytes[0] === ESC) {
        this.escTimer = setTimeout(() => {
          this.escTimer = undefined;
          // PROMOTED, not discarded -- the one difference from the truncated
          // -sequence branch below. The ESC stays in `buffer`; the `escHeld`
          // branch above resolves it on the NEXT pump() call.
          this.escHeld = true;
        }, ESC_TIMEOUT_MS);
        return;
      }

      this.escTimer = setTimeout(() => {
        this.escTimer = undefined;
        // A TRUNCATED sequence is DISCARDED, not typed and not promoted: an
        // unfinished `\x1b[?` is not text the user asked to send, and leaving
        // `[` behind would type a bracket into the field. Only the lone-ESC
        // case above survives its timer.
        this.buffer = [];
      }, ESC_TIMEOUT_MS);
      return;
    }
  }

  /**
   * Perform one action.
   *
   * THE 3270 HALF IS `applyAction` IN `@tn3270/frontend`, shared with every other
   * front end, and it is thin for the reason its own comment gives: every branch
   * delegates to `Keyboard` or `Session`, so if a branch grows logic that logic is in
   * the wrong package.
   *
   * WHAT STAYS HERE IS `quit` AND `toggleKeypad`, the two `applyAction` refuses: teardown is this
   * front end's and nobody else's -- restoring raw mode on every exit path is what stands between a
   * user and a terminal with no echo, and a GUI closes a window instead -- and what a keypad LOOKS
   * like is equally local, which is why this one is a list of 47 lines and the canvas front ends
   * draw buttons. `applyAction` THROWS on both rather than ignoring them, so a front end that
   * forgot either check fails loudly instead of becoming unquittable, or offering a chord that
   * silently does nothing.
   */
  private apply(action: Action): void {
    // THE OVERLAY IS THIS FRONT END'S ANSWER TO `toggleKeypad`: a navigable list, not a keypad --
    // c3270's keypad is 16x78 and would hide two thirds of the screen (`keypadOverlay.ts`).
    // `applyAction` THROWS on the action rather than ignoring it, so a front end that forgot to
    // intercept it dies on the keystroke instead of presenting a chord that does nothing.
    if (action.kind === 'toggleKeypad') { this.toggleOverlay(); return; }
    // Intercepted here for the same reason and with the same consequence: `applyAction` THROWS on
    // `transferForm`, so a front end that forgot this arm dies on the keystroke rather than
    // offering a chord that does nothing. (The web gateway REJECTS the kind instead -- see
    // `web/src/protocol.ts` -- because a browser transfer's filesystem is a stage-4 question.)
    if (action.kind === 'transferForm') { this.toggleTransfer(); return; }
    if (action.kind === 'quit') {
      this.quitting = true;
      this.restore();
      this.host.exit(0);
      return;                    // no draw: the terminal is no longer ours
    }
    applyAction(this.session, action);
    this.draw();
  }

  /** Open the special-keys list, or close an open one. */
  private toggleOverlay(): void {
    if (this.overlayShown) { this.closeOverlay(); return; }
    // NOT WHILE SUSPENDED. `draw()` paints nothing then, so opening would leave the list INVISIBLE
    // and yet owning the keyboard -- every keystroke swallowed by something the user cannot see,
    // and the list appearing out of nowhere when the terminal grew back. A 20x80 terminal is
    // suspended and still clears OVERLAY_MIN, so the fits check below does not cover this.
    if (this.suspended) return;
    if (!overlayFits(this.terminal())) {
      // NOT REACHABLE FROM A LIVE SESSION, and deliberately kept anyway: `tooSmall` already
      // demands 24x80 before a session runs and `OVERLAY_MIN` is 12x29, so every terminal that
      // reaches here clears it. What it guards is the gap between a shrink and its SIGWINCH, where
      // `terminal()` reads a size `replace()` has not acted on yet. `OVERLAY_MIN` was NOT inflated
      // to make this branch reachable -- see the note on it in keypadOverlay.ts.
      this.showMessage('terminal too small for the special-keys list');
      return;
    }
    this.overlayShown = true;
    this.overlaySelected = 0;
    this.overlayTop = 0;
    this.draw();
  }

  private closeOverlay(): void {
    this.overlayShown = false;
    this.clearOverlayTimer();
    // `overlayPending` is deliberately NOT emptied here: the byte that closed the list is still at
    // the front of it, and its caller both consumes that byte and forwards whatever shared the read
    // to `pump()`. Clearing it here dropped that remainder -- a silent lost keystroke.
    this.draw();
  }

  /**
   * Read the bytes as the overlay's, one key at a time.
   *
   * Esc closes, Enter fires the selection, CSI/SS3 `A`/`B` move it -- as do `k`/`w` and `j`/`s`, see
   * `OVERLAY_UP_LETTERS` -- Ctrl-K closes it again, and EVERYTHING ELSE IS SWALLOWED, including the
   * `h`/`l`/`a`/`d` a reader may expect beside those letters. See the interception in `onInput`.
   *
   * ## A SPLIT ARROW MUST NOT READ AS ESCAPE
   *
   * `\x1b` and `[B` can arrive in SEPARATE reads: that is the delivery `pump()`'s `escHeld` comment
   * records a regression for, so it is not hypothetical. Closing the overlay on the first of those
   * two reads would make the down arrow close it on any terminal that splits, which the user cannot
   * predict and cannot see. So an incomplete prefix is HELD here, with the same 50ms window
   * `pump()` uses, and only a lone ESC that OUTLIVES the window closes. A truncated `\x1b[` is
   * discarded and the list stays up, which mirrors `pump()`'s discard rather than its promotion.
   *
   * The cost is that Esc closes 50ms late. That is the same boundary `ESC_TIMEOUT_MS` documents,
   * and it fails safe in both directions: nothing is typed and nothing is sent either way.
   *
   * ## ONE READ, SEVERAL KEYS
   *
   * A loop, not a match on the whole chunk, for the reason `pump()` gives: autorepeat coalesced by
   * a slow link delivers `\x1b[B\x1b[B` as one read, which no whole-chunk comparison recognises --
   * the selection would appear to stop moving while the key was held.
   */
  private consumeOverlayKey(bytes: Uint8Array): void {
    for (const b of bytes) this.overlayPending.push(b);
    this.clearOverlayTimer();

    while (this.overlayShown && this.overlayPending.length > 0) {
      const taken = this.overlayKey(this.overlayPending);
      if (taken === 0) { this.holdOverlayPrefix(); return; }
      this.overlayPending.splice(0, taken);
    }

    if (this.overlayPending.length > 0) {
      // Bytes that shared a read with the keystroke that CLOSED the list belong to the screen
      // again. Dropping them would be the silent lost keystroke `pump()`'s docstring exists to
      // prevent, so they re-enter the ordinary path -- which is safe now that `overlayShown` is
      // false, so `onInput` will not intercept them a second time.
      for (const b of this.overlayPending) this.buffer.push(b);
      this.overlayPending = [];
      this.pump();
    }
  }

  /**
   * Act on the ONE key at the front of `pending`, returning how many bytes it consumed, or 0 when
   * the front is a prefix that more bytes could still complete.
   */
  private overlayKey(pending: readonly number[]): number {
    if (pending[0] !== ESC) {
      // The letters are single bytes with no prefix ambiguity, so they sit here with the other
      // single-byte keys and never reach the hold/timer path below.
      const letter = overlayLetterDelta(pending[0]);
      if (pending[0] === OVERLAY_CR || pending[0] === OVERLAY_LF) this.fireOverlay();
      else if (pending[0] === OVERLAY_TOGGLE) this.closeOverlay();
      // Ctrl-T SWAPS to the transfer form. Without this arm the exclusion is one-way: Ctrl-T from
      // the list would be swallowed like any other unrecognised byte, so the form would be
      // reachable from the screen but not from the list -- an inconsistency the user meets as
      // "the key works sometimes". `transferKey` has the mirror of this arm for Ctrl-K.
      else if (pending[0] === TRANSFER_TOGGLE) { this.closeOverlay(); this.toggleTransfer(); }
      else if (letter !== 0) this.moveOverlay(letter);
      return 1;
    }
    if (pending.length === 1) return 0;                         // Escape, or an arrow's first byte
    if (pending[1] === OVERLAY_CSI || pending[1] === OVERLAY_SS3) {
      if (pending.length === 2) return 0;                       // no final byte yet
      // BOTH FORMS, for the reason `bindings.ts` gives: any layer can flip DECCKM, so accepting
      // one of `\x1b[A`/`\x1bOA` would work in some terminals and not others.
      if (pending[2] === OVERLAY_UP) this.moveOverlay(-1);
      else if (pending[2] === OVERLAY_DOWN) this.moveOverlay(1);
      return 3;                            // any other function key: swallowed, whole
    }
    // ESC followed by something that cannot continue an arrow: it really was Escape.
    this.closeOverlay();
    return 1;
  }

  /** Wait out `ESC_TIMEOUT_MS` on a prefix the overlay cannot yet resolve. */
  private holdOverlayPrefix(): void {
    this.overlayTimer = setTimeout(() => {
      this.overlayTimer = undefined;
      const lone = this.overlayPending.length === 1 && this.overlayPending[0] === ESC;
      this.overlayPending = [];
      // A LONE ESC that outlived the window really was Escape, so it closes. A truncated
      // `\x1b[` is discarded with the list left open: an unfinished sequence is not a keypress.
      if (lone && this.overlayShown) this.closeOverlay();
    }, ESC_TIMEOUT_MS);
  }

  private clearOverlayTimer(): void {
    if (this.overlayTimer === undefined) return;
    clearTimeout(this.overlayTimer);
    this.overlayTimer = undefined;
  }

  private moveOverlay(delta: number): void {
    this.overlaySelected = moveSelection(this.overlaySelected, delta);
    this.draw();
  }

  /** Fire the selected key and close. */
  private fireOverlay(): void {
    const action = selectedAction(this.overlaySelected);
    // CLOSED BEFORE THE ACTION RUNS, and closing is what stops the next Return re-firing the same
    // key: with the list down, Return is the Enter AID again.
    this.overlayShown = false;
    this.clearOverlayTimer();
    applyAction(this.session, action);
    this.draw();
  }

  /**
   * The lines to draw: as many as fit, scrolled to keep the selection visible.
   *
   * SELECTION-FOLLOWING, NOT FIRST-N. `overlayLines` returns all 47 and Task 11 left the window to
   * its caller; a 24-row screen holds 24, so showing the first N would leave every key from the
   * 25th down -- Attention through Backspace, and Sys Req, whose only keyboard route this is --
   * permanently unreachable. The window moves only when the selection would leave it, so holding an
   * arrow scrolls a line at a time rather than jumping a page.
   *
   * Bounded by the TERMINAL as well as the screen. A live session's terminal is never smaller than
   * its screen (`tooSmall`), but addressing a row the terminal does not have would scroll the window
   * and corrupt every address computed afterwards, so the smaller of the two wins.
   */
  private overlayWindow(): readonly string[] {
    const lines = overlayLines(this.overlaySelected);
    const rows = Math.max(1, Math.min(this.session.screen.rows, this.terminal().rows));
    if (this.overlaySelected < this.overlayTop) this.overlayTop = this.overlaySelected;
    else if (this.overlaySelected >= this.overlayTop + rows) {
      this.overlayTop = this.overlaySelected - rows + 1;
    }
    this.overlayTop = Math.min(this.overlayTop, Math.max(0, lines.length - rows));
    return lines.slice(this.overlayTop, this.overlayTop + rows);
  }

  /**
   * Open the transfer form, or close an open one.
   *
   * NO SCROLL WINDOW, unlike `overlayWindow`: the form is at most 13 lines against `TRANSFER_MIN`'s
   * 15, so every line always fits and the whole list is handed to the renderer.
   */
  private toggleTransfer(): void {
    if (this.transferShown) { this.closeTransfer(); return; }
    // NOT WHILE SUSPENDED, exactly as `toggleOverlay` refuses: `draw()` paints nothing then, so
    // opening would leave the form INVISIBLE and yet owning the keyboard -- every keystroke
    // swallowed by something the user cannot see. A 20x80 terminal is suspended and still clears
    // TRANSFER_MIN, so the fits check below does not cover this.
    if (this.suspended) return;
    // MUTUALLY EXCLUSIVE with the keypad list. Two overlays both owning the keyboard is a state
    // the user cannot read: the one they cannot see swallows what they type. Closed AFTER the
    // suspended guard, so a refused open does not silently dismiss the list.
    if (this.overlayShown) this.closeOverlay();
    if (!transferFits(this.terminal())) {
      // NOT REACHABLE FROM A LIVE SESSION, for the reason `overlayFits`'s own branch gives:
      // `tooSmall` demands 24x80 before a session runs and TRANSFER_MIN is 15x56, so every
      // terminal that reaches here clears it. What it guards is the gap between a shrink and its
      // SIGWINCH. TRANSFER_MIN was NOT inflated to make this reachable -- see transferOverlay.ts.
      this.showMessage('terminal too small for the transfer form');
      return;
    }
    this.transferShown = true;
    // REOPENS EMPTY. A form that remembered its values would hand one operator's path -- and on a
    // send, the file they were reading -- to the next transfer, where a stale HostFile is a write
    // to a dataset nobody named in this session.
    this.transferState = newTransferForm();
    this.transferPhase = 'idle';
    this.transferProgress = undefined;
    this.draw();
  }

  /**
   * Close the form.
   *
   * A RUNNING TRANSFER MUST BE ABORTED RATHER THAN ABANDONED, which Task 8 adds here: walking away
   * leaves the host program waiting for a CUT frame that will never come, and the operator's next
   * keystroke goes into a host that is not listening for it. `CutTransfer.cancel` exists for it.
   *
   * `transferPending` is deliberately NOT emptied, for the reason `closeOverlay` gives: the byte
   * that closed the form is still at the front of it, and its caller both consumes that byte and
   * forwards whatever shared the read to `pump()`.
   */
  private closeTransfer(): void {
    this.transferShown = false;
    this.clearTransferTimer();
    this.draw();
  }

  /**
   * Read the bytes as the form's, one key at a time.
   *
   * ## A SPLIT ARROW MUST NOT READ AS ESCAPE
   *
   * The same hazard `consumeOverlayKey` documents, and not hypothetical: `\x1b` and `[C` can
   * arrive in separate reads. Closing on the first would make the right arrow close the form on
   * any terminal that splits -- discarding everything typed into it. So an incomplete prefix is
   * HELD with the same 50ms window `pump()` uses, and only a lone ESC that outlives it closes. A
   * truncated `\x1b[` is discarded with the form left open, mirroring `pump()`'s discard.
   *
   * ## ONE READ, SEVERAL KEYS
   *
   * A loop rather than a match on the chunk: autorepeat coalesced by a slow link delivers
   * `\x1b[C\x1b[C` as one read, and a whole-chunk comparison would see the field stop changing
   * while the key was held. Typing into a text field makes this more likely here than in the
   * overlay, not less -- a fast typist's keystrokes share reads routinely.
   */
  private consumeTransferKey(bytes: Uint8Array): void {
    for (const b of bytes) this.transferPending.push(b);
    this.clearTransferTimer();

    while (this.transferShown && this.transferPending.length > 0) {
      const taken = this.transferKey(this.transferPending);
      if (taken === 0) { this.holdTransferPrefix(); return; }
      this.transferPending.splice(0, taken);
    }

    if (this.transferPending.length > 0) {
      // Bytes that shared a read with the keystroke that CLOSED the form belong to the screen
      // again. Dropping them is the silent lost keystroke `pump()` exists to prevent, and it is
      // safe now that `transferShown` is false, so `onInput` will not intercept them again.
      for (const b of this.transferPending) this.buffer.push(b);
      this.transferPending = [];
      this.pump();
    }
  }

  /** Act on the ONE key at the front, returning bytes consumed, or 0 for an unresolved prefix. */
  private transferKey(pending: readonly number[]): number {
    const b = pending[0];
    if (b !== ESC) {
      if (b === OVERLAY_CR || b === OVERLAY_LF) this.submitTransfer();
      else if (b === TRANSFER_TOGGLE) this.closeTransfer();
      // Ctrl-K swaps to the keypad list rather than being swallowed, so the two overlays are
      // reachable from each other without a trip through the screen.
      else if (b === OVERLAY_TOGGLE) { this.closeTransfer(); this.toggleOverlay(); }
      else if (b === TAB) this.moveTransfer(1);
      else if (b === BACKSPACE || b === DEL) this.backspaceTransfer();
      // Printable ASCII only. A control byte this form does not name is SWALLOWED rather than
      // falling through to the screen, as the overlay swallows what it does not recognise.
      else if (b !== undefined && b >= 0x20 && b < 0x7f) this.typeTransfer(b);
      return 1;
    }
    if (pending.length === 1) return 0;                         // Escape, or an arrow's first byte
    if (pending[1] === OVERLAY_CSI || pending[1] === OVERLAY_SS3) {
      if (pending.length === 2) return 0;                       // no final byte yet
      // BOTH FORMS, for the reason `bindings.ts` gives: any layer can flip DECCKM, so accepting
      // one of `\x1b[C`/`\x1bOC` would work in some terminals and not others. BackTab arrives as
      // CSI Z, which is three bytes like the arrows.
      if (pending[2] === OVERLAY_UP) this.moveTransfer(-1);
      else if (pending[2] === OVERLAY_DOWN) this.moveTransfer(1);
      else if (pending[2] === TRANSFER_RIGHT) this.cycleTransfer(1);
      else if (pending[2] === TRANSFER_LEFT) this.cycleTransfer(-1);
      else if (pending[2] === TRANSFER_BACKTAB) this.moveTransfer(-1);
      return 3;                            // any other function key: swallowed, whole
    }
    // ESC followed by something that cannot continue an arrow: it really was Escape.
    this.closeTransfer();
    return 1;
  }

  /** Wait out `ESC_TIMEOUT_MS` on a prefix the form cannot yet resolve. */
  private holdTransferPrefix(): void {
    this.transferTimer = setTimeout(() => {
      this.transferTimer = undefined;
      const lone = this.transferPending.length === 1 && this.transferPending[0] === ESC;
      this.transferPending = [];
      // A LONE ESC that outlived the window really was Escape, so it closes. A truncated `\x1b[`
      // is discarded with the form left open: an unfinished sequence is not a keypress, and here
      // closing would also discard everything typed.
      if (lone && this.transferShown) this.closeTransfer();
    }, ESC_TIMEOUT_MS);
  }

  private clearTransferTimer(): void {
    if (this.transferTimer === undefined) return;
    clearTimeout(this.transferTimer);
    this.transferTimer = undefined;
  }

  private moveTransfer(delta: number): void {
    this.transferState = moveField(this.transferState, delta);
    this.draw();
  }

  /**
   * Cycle the selected field, if it is a cycle field.
   *
   * ## A CYCLE CANNOT HIDE THE FIELD THAT IS SELECTED, AND THAT WAS MEASURED
   *
   * The plan added a repair here -- `moveField(1)` when the selection became inapplicable -- on
   * the theory that flipping Mode to binary hides Cr while Cr is selected. IT IS UNREACHABLE: a
   * field's applicability depends only on OTHER fields (`recfm` on direction, `lrecl` on direction
   * and recfm, `blksize` on those and host, `cr` on mode), so cycling a field can hide others but
   * never itself. Verified exhaustively over all 360 reachable value-states x every selectable
   * cycle field x both deltas -- 4128 operations, zero cases where the selection ended
   * inapplicable. The repair was dropped rather than kept as dead code with a test that could only
   * pass vacuously; if a future field's applicability depends on itself, `transferForm.test.ts`'s
   * own rules are where that shows up first.
   *
   * What IS reachable is a cycle hiding a DIFFERENT field, which `clearInapplicable` handles in
   * the model by clearing its value, and `moveField` handles for the selection by skipping it.
   */
  private cycleTransfer(delta: number): void {
    const field = TRANSFER_FIELDS[this.transferState.selected];
    if (field === undefined) return;
    this.transferState = cycleField(this.transferState, field.id, delta);
    this.draw();
  }

  private typeTransfer(byte: number): void {
    const field = TRANSFER_FIELDS[this.transferState.selected];
    if (field === undefined || field.kind === 'cycle') return;
    const current = this.transferState.values[field.id];
    this.transferState = setFieldText(
      this.transferState, field.id, current + String.fromCharCode(byte),
    );
    this.draw();
  }

  private backspaceTransfer(): void {
    const field = TRANSFER_FIELDS[this.transferState.selected];
    if (field === undefined || field.kind === 'cycle') return;
    const current = this.transferState.values[field.id];
    this.transferState = setFieldText(this.transferState, field.id, current.slice(0, -1));
    this.draw();
  }

  /** Task 8 runs the transfer. Validation first, so the form can show an error. */
  private submitTransfer(): void {
    // Deliberately inert for now, and NOT a fall-through to the host: Enter must not reach the
    // session as an AID while the form is up, which `app.test.ts` pins.
  }

  /**
   * Write one transient line, leaving the screen otherwise intact.
   *
   * THERE WAS NO MESSAGE FACILITY HERE TO REUSE, and this is the third kind rather than a fourth
   * mechanism: the key-binding hint is a RENDERER option fixed at construction (`hintParts` in
   * render.ts), the OIA text is the session's own, and the only other message -- the too-small
   * notice in `replace()` -- clears the whole terminal, which is right for a session that has
   * stopped painting and wrong for a refusal that must leave the screen readable.
   *
   * So: the terminal's first row, no `\x1b[2J`, and `invalidate()` WITHOUT a draw, so the message
   * survives until the next paint (a keystroke, or a screen event) and that paint -- a full one,
   * border and hint included -- puts back the row it sat on.
   */
  private showMessage(text: string): void {
    // The same three guards `draw()` has, and `suspended` for the same reason it does: the too-small
    // notice sits at 1;1 too, and overwriting "Resize to continue" with anything else would replace
    // the one instruction that gets the user out of that state.
    if (this.quitting || this.restored || this.suspended) return;
    this.stdout.write(`\x1b[1;1H\x1b[0m\x1b[K${text}`);
    this.renderer.invalidate();
  }
}
