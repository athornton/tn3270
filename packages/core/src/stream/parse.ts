import { Cmd, SnaCmd, Order } from '../constants.js';
import { decodeAddress, AddressError } from '../address.js';
import { parseStructuredFields, SfParseError, type StructuredField } from './sf.js';

/**
 * Turn one 3270 record into a command plus a token list. Pure: no Screen, no
 * mutation, no I/O. Anything malformed throws ParseError, which the session
 * turns into a program check.
 */

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export type CommandName =
  | 'Write'
  | 'EraseWrite'
  | 'EraseWriteAlternate'
  | 'EraseAllUnprotected'
  | 'ReadBuffer'
  | 'ReadModified'
  | 'ReadModifiedAll'
  | 'WriteStructuredField'
  | 'NoOp';

export type Token =
  | { kind: 'data'; bytes: Uint8Array }
  | { kind: 'sba'; address: number }
  | { kind: 'sf'; attr: number }
  | { kind: 'ic' }
  | { kind: 'pt' }
  | { kind: 'ra'; stop: number; fill: number; ge: boolean }
  | { kind: 'eua'; stop: number }
  | { kind: 'ge'; ebcdic: number }
  /** SA/SFE/MF: recognized so they can be skipped by length, not executed. */
  | { kind: 'deferred'; order: number; data: Uint8Array }
  /** One structured field from a WSF record, parsed by stream/sf.ts. */
  | { kind: 'structuredField'; field: StructuredField };

export interface ParsedRecord {
  command: CommandName;
  /** Present only for the write commands. */
  wcc?: number;
  tokens: Token[];
}

/** Commands that take a WCC byte. */
const WRITE_COMMANDS = new Set<CommandName>([
  'Write', 'EraseWrite', 'EraseWriteAlternate',
]);

function commandOf(byte: number): CommandName | null {
  switch (byte) {
    case SnaCmd.W: case Cmd.W: return 'Write';
    case SnaCmd.EW: case Cmd.EW: return 'EraseWrite';
    case SnaCmd.EWA: case Cmd.EWA: return 'EraseWriteAlternate';
    case SnaCmd.EAU: case Cmd.EAU: return 'EraseAllUnprotected';
    case SnaCmd.RB: case Cmd.RB: return 'ReadBuffer';
    case SnaCmd.RM: case Cmd.RM: return 'ReadModified';
    case SnaCmd.RMA: case Cmd.RMA: return 'ReadModifiedAll';
    // Both WSF encodings, like every other command. Cmd.WSF is 0x11, the same
    // value as Order.SBA — safe here because this function is only ever called
    // on the command byte, never on an order byte.
    case SnaCmd.WSF: case Cmd.WSF: return 'WriteStructuredField';
    case Cmd.NOP: return 'NoOp';
    default: return null;
  }
}

export function parseRecord(record: Uint8Array): ParsedRecord {
  if (record.length === 0) throw new ParseError('empty record');

  const cmdByte = record[0]!;
  const command = commandOf(cmdByte);
  if (command === null) {
    throw new ParseError(`unknown command 0x${cmdByte.toString(16).padStart(2, '0')}`);
  }

  let i = 1;
  let wcc: number | undefined;
  if (WRITE_COMMANDS.has(command)) {
    if (i >= record.length) throw new ParseError(`${command} with no WCC byte`);
    wcc = record[i++]!;
  }

  // Non-SNA WSF is 0x11, the same value as the SBA order; position tells them
  // apart, which is why this check is on the command byte only.
  if (command === 'WriteStructuredField') {
    const data = record.subarray(i);
    try {
      const tokens: Token[] = parseStructuredFields(data)
        .map((field) => ({ kind: 'structuredField', field }));
      return { command, tokens };
    } catch (e) {
      // Surface SF framing errors as ParseError so session.ts maps them to
      // X PROG the same way as every other malformed record. This is not
      // cosmetic: session.ts:201-207 program-checks ParseError/AddressError and
      // RETHROWS anything else as "our own bug", which drops the connection. An
      // SfParseError escaping here would disconnect on a malformed host record.
      //
      // Rejecting the record as a whole discards well-formed fields ahead of
      // the bad one. x3270 instead dispatches each field as it walks, so an
      // earlier Read Partition has already been answered before it bails on a
      // later length error (sf.c:146-151 return after the per-field dispatch at
      // sf.c:153-183) — and it calls that out as a wart, sf.c:185-191: "if we
      // have already / generated some output, then we have already positively /
      // acknowledged the request, so if we fail here, we have no / way to
      // return the error indication." Accepted here because a partial WSF is a
      // host bug and X PROG is the honest answer; revisit if a real host is
      // found that splits fields that way.
      if (e instanceof SfParseError) throw new ParseError(e.message);
      throw e;
    }
  }

  const tokens: Token[] = [];
  let run: number[] = [];

  const flushRun = (): void => {
    if (run.length) {
      tokens.push({ kind: 'data', bytes: Uint8Array.from(run) });
      run = [];
    }
  };

  const need = (n: number, what: string): void => {
    if (i + n > record.length) throw new ParseError(`${what} truncated at end of record`);
  };

  const address = (what: string): number => {
    need(2, what);
    const b1 = record[i++]!;
    const b2 = record[i++]!;
    try {
      return decodeAddress(b1, b2);
    } catch (e) {
      if (e instanceof AddressError) throw new ParseError(`${what}: ${e.message}`);
      throw e;
    }
  };

  while (i < record.length) {
    const b = record[i]!;
    switch (b) {
      case Order.SBA: {
        flushRun();
        i++;
        tokens.push({ kind: 'sba', address: address('SBA') });
        break;
      }
      case Order.SF: {
        flushRun();
        i++;
        need(1, 'SF');
        tokens.push({ kind: 'sf', attr: record[i++]! });
        break;
      }
      case Order.IC: {
        flushRun();
        i++;
        tokens.push({ kind: 'ic' });
        break;
      }
      case Order.PT: {
        flushRun();
        i++;
        tokens.push({ kind: 'pt' });
        break;
      }
      case Order.RA: {
        flushRun();
        i++;
        const stop = address('RA');
        // RA may carry a Graphic Escape before its fill character, in which case
        // the fill is the byte AFTER the GE. x3270 checks for this explicitly
        // (ctlr.c:1739-1746). Taking the byte after the address unconditionally
        // would store 0x08 as the fill and leak the real character out as a
        // stray data byte.
        need(1, 'RA fill character');
        let ge = false;
        if (record[i] === Order.GE) {
          ge = true;
          i++;
          need(1, 'RA GE fill character');
        }
        tokens.push({ kind: 'ra', stop, fill: record[i++]!, ge });
        break;
      }
      case Order.EUA: {
        flushRun();
        i++;
        tokens.push({ kind: 'eua', stop: address('EUA') });
        break;
      }
      case Order.GE: {
        flushRun();
        i++;
        need(1, 'GE');
        tokens.push({ kind: 'ge', ebcdic: record[i++]! });
        break;
      }
      case Order.SA: {
        // Two operand bytes: attribute type and value.
        flushRun();
        i++;
        need(2, 'SA');
        tokens.push({ kind: 'deferred', order: Order.SA, data: Uint8Array.from(record.subarray(i, i + 2)) });
        i += 2;
        break;
      }
      case Order.SFE:
      case Order.MF: {
        // One count byte, then that many type/value pairs.
        const order = b;
        flushRun();
        i++;
        need(1, order === Order.SFE ? 'SFE count' : 'MF count');
        const count = record[i]!;
        const operandLen = 1 + count * 2;
        need(operandLen, order === Order.SFE ? 'SFE' : 'MF');
        tokens.push({
          kind: 'deferred',
          order,
          data: Uint8Array.from(record.subarray(i, i + operandLen)),
        });
        i += operandLen;
        break;
      }
      default:
        run.push(b);
        i++;
        break;
    }
  }
  flushRun();

  return wcc === undefined ? { command, tokens } : { command, wcc, tokens };
}

/**
 * Nested union: the return type makes a missing SF kind a compile error.
 *
 * Extracted rather than switched inline because a nested switch inside
 * describeRecord's own switch gets no exhaustiveness checking, and a
 * StructuredField variant added by a later stage would silently vanish from the
 * trace. x3270's equivalent dispatch has a case per outbound SFID (sf.c:153-183).
 *
 * "unknownSF" not "SF": describeRecord's `case 'sf'` below already emits SF( for
 * the Start Field ORDER, so one grep over a trace would return both. x3270 words
 * this one "unsupported ID 0x%02x" (sf.c:180).
 */
function describeStructuredField(f: StructuredField): string {
  switch (f.kind) {
    case 'readPartition':
      // PID is padded like every other hex here: 0x00 is a reachable, meaningful
      // value (a read of partition 0, NOT a query), and "pid=0x0" would read as
      // a truncation bug in the emulator rather than a byte off the wire.
      return `ReadPartition(pid=0x${f.pid.toString(16).padStart(2, '0')}`
        + `,type=0x${f.type.toString(16).padStart(2, '0')})`;
    case 'unknownSf':
      return `unknownSF(0x${f.sfid.toString(16).padStart(2, '0')},${f.data.length}B)`;
  }
}

/** One-line annotation of a record, for the trace. Never throws. */
export function describeRecord(record: Uint8Array): string {
  let parsed: ParsedRecord;
  try {
    parsed = parseRecord(record);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `unparseable record (${msg})`;
  }
  const parts: string[] = [parsed.command];
  if (parsed.wcc !== undefined) {
    parts.push(`WCC=0x${parsed.wcc.toString(16).padStart(2, '0')}`);
  }
  for (const t of parsed.tokens) {
    switch (t.kind) {
      case 'data': parts.push(`data[${t.bytes.length}]`); break;
      case 'sba': parts.push(`SBA(${t.address})`); break;
      case 'sf': parts.push(`SF(0x${t.attr.toString(16).padStart(2, '0')})`); break;
      case 'ic': parts.push('IC'); break;
      case 'pt': parts.push('PT'); break;
      case 'ra': parts.push(`RA(->${t.stop},${t.ge ? 'GE ' : ''}0x${t.fill.toString(16).padStart(2, '0')})`); break;
      case 'eua': parts.push(`EUA(->${t.stop})`); break;
      case 'ge': parts.push(`GE(0x${t.ebcdic.toString(16).padStart(2, '0')})`); break;
      case 'deferred': parts.push(`deferred(0x${t.order.toString(16)},${t.data.length}B)`); break;
      case 'structuredField': parts.push(describeStructuredField(t.field)); break;
    }
  }
  return parts.join(' ');
}
