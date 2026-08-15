import { Cmd, SnaCmd, Order } from '../constants.js';
import { decodeAddress, AddressError } from '../address.js';

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
  | { kind: 'ra'; stop: number; fill: number }
  | { kind: 'eua'; stop: number }
  | { kind: 'ge'; ebcdic: number }
  /** SA/SFE/MF: recognized so they can be skipped by length, not executed. */
  | { kind: 'deferred'; order: number; data: Uint8Array }
  /** WSF payload, unexamined in stage 1. */
  | { kind: 'structuredFields'; data: Uint8Array };

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
    case SnaCmd.WSF: return 'WriteStructuredField';
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
    return { command, tokens: data.length ? [{ kind: 'structuredFields', data: Uint8Array.from(data) }] : [] };
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
        need(1, 'RA fill character');
        tokens.push({ kind: 'ra', stop, fill: record[i++]! });
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
      case 'ra': parts.push(`RA(->${t.stop},0x${t.fill.toString(16).padStart(2, '0')})`); break;
      case 'eua': parts.push(`EUA(->${t.stop})`); break;
      case 'ge': parts.push(`GE(0x${t.ebcdic.toString(16).padStart(2, '0')})`); break;
      case 'deferred': parts.push(`deferred(0x${t.order.toString(16)},${t.data.length}B)`); break;
      case 'structuredFields': parts.push(`WSF[${t.data.length}B]`); break;
    }
  }
  return parts.join(' ');
}
