/**
 * Byte-level session trace.
 *
 * Two jobs: let a human see what went over the wire, and produce a file that
 * can be replayed as a test fixture. The format is deliberately plain text so
 * it diffs and greps:
 *
 *   <elapsed> <dir> <hex bytes...>  [# annotation]
 *
 * where dir is '<' for received, '>' for sent, '=' for a note, or '+' for a
 * continuation of the previous line's byte run (used when a single recv()/
 * send() call is wrapped across more than one line). Timestamps are seconds
 * since the first event, so two traces of the same session compare cleanly
 * regardless of wall clock.
 */

export type TraceDir = 'recv' | 'send';

export interface TraceOptions {
  enabled?: boolean;
  /** Injectable for tests; defaults to Date.now. */
  clock?: () => number;
  /** Called with each finished line — wire this to a file stream. */
  sink?: (line: string) => void;
}

const BYTES_PER_LINE = 16;

/** Newlines in user-supplied text could otherwise forge a fake trace line. */
function sanitizeText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

export class Trace {
  private enabled: boolean;
  private readonly clock: () => number;
  private readonly sink: ((line: string) => void) | undefined;
  private readonly buffered: string[] = [];
  private start: number | undefined;

  constructor(opts: TraceOptions = {}) {
    this.enabled = opts.enabled ?? false;
    this.clock = opts.clock ?? (() => Date.now());
    this.sink = opts.sink;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  recv(bytes: Uint8Array, annotation?: string): void {
    this.emitBytes('<', bytes, annotation);
  }

  send(bytes: Uint8Array, annotation?: string): void {
    this.emitBytes('>', bytes, annotation);
  }

  /** A message with no bytes — negotiation milestones, program checks, etc. */
  note(text: string): void {
    if (!this.enabled) return;
    this.emit(`${this.stamp()} = # ${sanitizeText(text)}`);
  }

  /** A snapshot of the lines recorded so far. Mutating it does not affect the trace. */
  lines(): readonly string[] {
    return [...this.buffered];
  }

  toText(): string {
    return this.buffered.join('\n');
  }

  private emitBytes(marker: '<' | '>', bytes: Uint8Array, annotation?: string): void {
    if (!this.enabled) return;
    if (bytes.length === 0) return;
    const stamp = this.stamp();
    const safeAnnotation = annotation !== undefined ? sanitizeText(annotation) : undefined;
    for (let off = 0; off < bytes.length; off += BYTES_PER_LINE) {
      const chunk = bytes.subarray(off, off + BYTES_PER_LINE);
      const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, '0')).join(' ');
      const isFirst = off === 0;
      const isLast = off + BYTES_PER_LINE >= bytes.length;
      const lineMarker = isFirst ? marker : '+';
      const suffix = isLast && safeAnnotation ? `  # ${safeAnnotation}` : '';
      this.emit(`${stamp} ${lineMarker} ${hex}${suffix}`);
    }
  }

  private emit(line: string): void {
    // A sink means the caller owns persistence (e.g. a file stream); retaining
    // every line here too would mean a long session holds its entire trace in
    // memory regardless. Without a sink, buffering is the only way lines() and
    // toText() can ever return anything, so we keep it in that case.
    if (this.sink) {
      this.sink(line);
    } else {
      this.buffered.push(line);
    }
  }

  private stamp(): string {
    const now = this.clock();
    this.start ??= now;
    // Clamp at 0: a clock that steps backward (e.g. an NTP correction on a
    // non-monotonic clock) must not produce a negative elapsed time, which
    // parseTrace's line regex would fail to match and silently drop.
    const elapsed = Math.max(0, (now - this.start) / 1000);
    return elapsed.toFixed(3);
  }
}

export interface TraceEvent {
  dir: TraceDir;
  bytes: Uint8Array;
}

const HEX_BYTE = /^[0-9a-fA-F]{1,2}$/;

/** Parses one line's whitespace-separated hex tokens, validating each. */
function parseHexPayload(payload: string, lineNo: number, rawLine: string): Uint8Array {
  if (payload === '') return new Uint8Array(0);
  const tokens = payload.split(/\s+/);
  const bytes = new Uint8Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!HEX_BYTE.test(tok)) {
      throw new Error(
        `parseTrace: invalid hex byte "${tok}" on line ${lineNo}: ${rawLine}`,
      );
    }
    bytes[i] = Number.parseInt(tok, 16);
  }
  return bytes;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Parse a trace back into byte runs, for Replay(). Notes and comments are
 * dropped — they are commentary, not protocol. A '+' continuation line is
 * merged into the byte run of the event immediately before it, so a run that
 * Trace wrapped across several 16-byte lines round-trips as the single event
 * it originally was. This matters: Tasks 15-17 replay fixtures to test the
 * framer against real chunk boundaries, and a wrapped run merged back into one
 * event is what makes that possible.
 */
export function parseTrace(text: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    const m = /^([0-9.]+)\s+([<>=+])\s*(.*)$/.exec(line);
    if (!m) continue;
    const lineNo = i + 1;
    const marker = m[2]!;
    if (marker === '=') continue;
    const payload = m[3]!.replace(/\s*#.*$/, '').trim();
    const bytes = parseHexPayload(payload, lineNo, raw);
    if (bytes.length === 0) continue;

    if (marker === '+') {
      const prev = events[events.length - 1];
      if (!prev) {
        throw new Error(
          `parseTrace: continuation line ${lineNo} with no preceding event: ${raw}`,
        );
      }
      prev.bytes = concatBytes(prev.bytes, bytes);
    } else {
      events.push({ dir: marker === '<' ? 'recv' : 'send', bytes });
    }
  }
  return events;
}
