/**
 * Byte-level session trace.
 *
 * Two jobs: let a human see what went over the wire, and produce a file that
 * can be replayed as a test fixture. The format is deliberately plain text so
 * it diffs and greps:
 *
 *   <elapsed> <dir> <hex bytes...>  [# annotation]
 *
 * where dir is '<' for received, '>' for sent, '=' for a note. Timestamps are
 * seconds since the first event, so two traces of the same session compare
 * cleanly regardless of wall clock.
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
    this.emit(`${this.stamp()} = # ${text}`);
  }

  lines(): readonly string[] {
    return this.buffered;
  }

  toText(): string {
    return this.buffered.join('\n');
  }

  private emitBytes(marker: string, bytes: Uint8Array, annotation?: string): void {
    if (!this.enabled) return;
    if (bytes.length === 0) return;
    const stamp = this.stamp();
    for (let off = 0; off < bytes.length; off += BYTES_PER_LINE) {
      const chunk = bytes.subarray(off, off + BYTES_PER_LINE);
      const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, '0')).join(' ');
      const isLast = off + BYTES_PER_LINE >= bytes.length;
      const suffix = isLast && annotation ? `  # ${annotation}` : '';
      this.emit(`${stamp} ${marker} ${hex}${suffix}`);
    }
  }

  private emit(line: string): void {
    this.buffered.push(line);
    this.sink?.(line);
  }

  private stamp(): string {
    const now = this.clock();
    this.start ??= now;
    return ((now - this.start) / 1000).toFixed(3);
  }
}

export interface TraceEvent {
  dir: TraceDir;
  bytes: Uint8Array;
}

/**
 * Parse a trace back into byte runs, for Replay(). Notes and comments are
 * dropped — they are commentary, not protocol. Each line becomes one event;
 * a wrapped run therefore replays as consecutive events, which is
 * indistinguishable from the receiver's point of view since the framer
 * buffers across chunk boundaries anyway.
 */
export function parseTrace(text: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^([0-9.]+)\s+([<>=])\s*(.*)$/.exec(line);
    if (!m) continue;
    const marker = m[2]!;
    if (marker === '=') continue;
    const payload = m[3]!.replace(/\s*#.*$/, '').trim();
    if (payload === '') continue;
    const bytes = Uint8Array.from(
      payload.split(/\s+/).map((h) => Number.parseInt(h, 16)),
    );
    events.push({ dir: marker === '<' ? 'recv' : 'send', bytes });
  }
  return events;
}
