import type { TraceEvent } from './trace.js';

/**
 * Read x3270's native `-trace` file format.
 *
 * This is NOT our own trace format — see trace.ts for that one. x3270 writes
 * network data through trace_netdata() (Common/telnet.c:3325):
 *
 *     for (offset = 0; offset < len; offset++) {
 *         if (!(offset % LINEDUMP_MAX))
 *             ntvtrace("%s%c 0x%-3x ", (offset? "\n": ""), direction, offset);
 *         ntvtrace("%02x", buf[offset]);
 *     }
 *
 * with LINEDUMP_MAX = 32. So a record looks like:
 *
 *     < 0x0   f5c31140401df0...
 *     < 0x20  c1c2c3...
 *     > 0x0   7d4040...
 *
 * Three differences from our format, all of which matter:
 *   1. The second field is a byte OFFSET within the record (`0x0`, `0x20`, …),
 *      not a timestamp. A continuation line is any line whose offset is nonzero.
 *   2. Hex bytes are UNSPACED, 32 per line.
 *   3. `<` means data the client SENT to the host, and `>` means data RECEIVED
 *      from it — the opposite of our convention. x3270 calls trace_netdata('<',
 *      obuf, ...) from its output path (telnet.c:632 and friends, where obuf is
 *      the outbound buffer).
 *
 * Getting direction backwards would silently invert a conformance comparison, so
 * it is asserted by test rather than assumed.
 *
 * Interleaved among the data lines are x3270's human-readable annotations
 * ("RCVD EOR", "< WriteStructuredField", timing marks, and so on). Those are
 * skipped: only lines matching the netdata dump shape are read.
 */

/** One line of an x3270 netdata dump: direction, offset, unspaced hex. */
const NETDATA_LINE = /^([<>])\s+0x([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s*$/;

/**
 * Parse an x3270 trace file into direction-tagged byte runs, using OUR direction
 * convention (`recv` = host to terminal), so the result is directly comparable
 * with parseTrace() output.
 *
 * Consecutive lines of one record are joined: a line with offset 0 starts a new
 * event, and any nonzero offset continues the previous one.
 */
export function parseX3270Trace(text: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  let current: { dir: 'recv' | 'send'; bytes: number[] } | undefined;

  const flush = (): void => {
    if (current !== undefined) {
      events.push({ dir: current.dir, bytes: Uint8Array.from(current.bytes) });
      current = undefined;
    }
  };

  for (const raw of text.split('\n')) {
    const m = NETDATA_LINE.exec(raw.trimEnd());
    if (m === null) {
      // An annotation line, a blank, or anything else x3270 writes. It ends the
      // current record: a record's continuation lines are contiguous.
      flush();
      continue;
    }

    const marker = m[1]!;
    const offset = Number.parseInt(m[2]!, 16);
    const hex = m[3]!;

    if (hex.length % 2 !== 0) {
      throw new Error(`x3270 trace: odd hex digit count on line: ${raw.trim()}`);
    }

    // Invert the direction: x3270's '<' is its own output, i.e. our 'send'.
    const dir: 'recv' | 'send' = marker === '<' ? 'send' : 'recv';

    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
    }

    if (offset === 0 || current === undefined || current.dir !== dir) {
      flush();
      current = { dir, bytes };
    } else {
      current.bytes.push(...bytes);
    }
  }
  flush();

  return events;
}

/**
 * Convert an x3270 trace to our own trace format, so it can be fed to
 * Session.replay() or stored as a fixture alongside natively-recorded traces.
 *
 * Timestamps are all zero: x3270's netdata lines carry offsets, not times, so
 * the timing information simply is not in the file. Emitting 0.000 is honest;
 * inventing plausible timings would not be.
 */
export function x3270TraceToOurs(text: string): string {
  const lines: string[] = [
    '# Converted from an x3270 -trace capture by x3270TraceToOurs().',
    '# Timestamps are 0.000 throughout: x3270 netdata lines carry byte offsets,',
    '# not times, so no timing information exists in the source file.',
  ];
  for (const ev of parseX3270Trace(text)) {
    const marker = ev.dir === 'recv' ? '<' : '>';
    const hex = Array.from(ev.bytes, (b) => b.toString(16).padStart(2, '0'));
    for (let i = 0; i < hex.length; i += 16) {
      const chunk = hex.slice(i, i + 16).join(' ');
      lines.push(`0.000 ${i === 0 ? marker : '+'} ${chunk}`);
    }
  }
  return lines.join('\n') + '\n';
}
