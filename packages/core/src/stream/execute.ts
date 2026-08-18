import { WCC, FA } from '../constants.js';
import type { Screen } from '../screen.js';
import type { ParsedRecord, Token, CommandName } from './parse.js';

/**
 * Apply a parsed record to a screen.
 *
 * Throws ExecuteError for conditions the hardware treats as a program check
 * (an address beyond the buffer, for instance). The session catches it, shows
 * X PROG in the OIA, and keeps the connection up.
 */

export class ExecuteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecuteError';
  }
}

export interface ExecuteResult {
  /** The host asked us to send something back. */
  readRequest?: Extract<CommandName, 'ReadBuffer' | 'ReadModified' | 'ReadModifiedAll'>;
  /** WCC bit 6: unlock the keyboard. */
  keyboardRestore: boolean;
  /** WCC bit 5: sound the alarm. */
  alarm: boolean;
  /** WCC bit 4 asked for a local copy and we have no printer. */
  printerUnavailable: boolean;
  /** How many structured fields we skipped, for the trace. */
  structuredFieldsIgnored: number;
  /** Set when a recoverable protocol fault occurred. */
  programCheck?: string;
}

export function execute(screen: Screen, record: ParsedRecord): ExecuteResult {
  const result: ExecuteResult = {
    keyboardRestore: false,
    alarm: false,
    printerUnavailable: false,
    structuredFieldsIgnored: 0,
  };

  switch (record.command) {
    case 'NoOp':
      return result;

    case 'ReadBuffer':
    case 'ReadModified':
    case 'ReadModifiedAll':
      result.readRequest = record.command;
      return result;

    case 'EraseAllUnprotected':
      // Screen.eraseAllUnprotected handles the unformatted case by clearing the
      // whole buffer (x3270 ctlr.c:1443-1445 `else ctlr_clear(true)`), since an
      // unformatted buffer is entirely unprotected.
      screen.eraseAllUnprotected();
      // EAU also unlocks the keyboard and homes the cursor. Use the screen's
      // own helper, which skips zero-length fields the way x3270's
      // next_unprotected does (ctlr.c:623-638) — a zero-length field's `start`
      // is another field attribute, and parking the cursor there corrupts the
      // buffer on the next keystroke.
      screen.cursor = screen.firstUnprotectedStart() ?? 0;
      result.keyboardRestore = true;
      return result;

    case 'WriteStructuredField':
      for (const t of record.tokens) {
        if (t.kind === 'structuredField') result.structuredFieldsIgnored++;
      }
      return result;

    case 'EraseWrite':
    case 'EraseWriteAlternate':
      // On a model 2 the alternate size equals the default, so both clear the
      // same buffer. TN3270E gives them different behavior.
      screen.clear();
      break;

    case 'Write':
      break;
  }

  const wcc = record.wcc ?? 0;
  // WCC reset-MDT is UNCONDITIONAL: manual Table 3-2 bit 7 says "all MDT bits in
  // the device's existing character buffer are reset", and x3270's handler
  // (ctlr.c:1545-1550) calls mdt_clear on every field attribute with no
  // protection check. This matters because ctlr_read_modified filters on
  // FA_IS_MODIFIED alone (ctlr.c:921) — a protected field carrying MODIFY would
  // otherwise leak its data to the host. Erase Input is the unprotected-only
  // one; see Screen.clearUnprotectedMDT.
  if (wcc & WCC.RESET_MDT) screen.clearAllMDT();
  if (wcc & WCC.KEYBOARD_RESTORE) result.keyboardRestore = true;
  if (wcc & WCC.SOUND_ALARM) result.alarm = true;
  if (wcc & WCC.START_PRINTER) result.printerUnavailable = true;

  let addr = 0;
  /** True when the previous token wrote something — PT nulls only then. */
  let wroteSinceOrder = false;

  for (const token of record.tokens) {
    addr = applyToken(screen, token, addr, () => { wroteSinceOrder = true; }, wroteSinceOrder);
    if (token.kind !== 'data' && token.kind !== 'ge' && token.kind !== 'ra') {
      wroteSinceOrder = false;
    }
  }

  return result;
}

function applyToken(
  screen: Screen,
  token: Token,
  addr: number,
  markWrote: () => void,
  wroteSinceOrder: boolean,
): number {
  switch (token.kind) {
    case 'sba':
      requireOnScreen(screen, token.address, 'SBA');
      return token.address;

    case 'sf':
      screen.setFieldAttribute(addr, token.attr);
      return screen.inc(addr);

    case 'ic':
      screen.cursor = addr;
      return addr;

    case 'data': {
      let a = addr;
      for (const b of token.bytes) {
        screen.setChar(a, b);
        a = screen.inc(a);
      }
      markWrote();
      return a;
    }

    case 'ge':
      // Stage 1 has no loadable character sets, so a graphic-escaped character
      // is stored as an ordinary byte. When Programmable Symbol Sets land, this
      // is where the cell becomes {kind:'ps',...} instead.
      screen.setChar(addr, token.ebcdic);
      markWrote();
      return screen.inc(addr);

    case 'ra': {
      requireOnScreen(screen, token.stop, 'RA');
      // do-while: stop === addr fills the whole buffer, matching x3270.
      // token.ge is deliberately carried and not acted on here: stage 1 has no
      // loadable character sets, so a graphic-escaped fill is stored as the
      // ordinary byte it is. Programmable Symbol Sets (a committed stage 4
      // deliverable) is where the cell would become {kind:'ps',...} instead,
      // and the flag exists so that change stays local to this case.
      let a = addr;
      do {
        screen.setChar(a, token.fill);
        a = screen.inc(a);
      } while (a !== token.stop);
      markWrote();
      return a;
    }

    case 'eua': {
      requireOnScreen(screen, token.stop, 'EUA');
      // Carry the governing attribute forward instead of calling fieldAt per
      // cell: fieldAt is O(size), so a per-cell call over a full buffer is
      // ~3.7M operations. x3270 does the same by tracking current_fa and
      // updating it when it encounters an attribute (ctlr.c:1809-1816).
      let a = addr;
      let protectedHere = screen.fieldAt(a)?.protected ?? false;
      do {
        const attr = screen.attributeAt(a);
        if (attr !== null) {
          // A field attribute: never erased, and it changes what follows.
          protectedHere = (attr & FA.PROTECT) !== 0;
        } else if (!protectedHere) {
          screen.setChar(a, 0x00);
        }
        a = screen.inc(a);
      } while (a !== token.stop);
      return a;
    }

    case 'pt': {
      // Advance to the first data cell of the next unprotected field. If the
      // previous token wrote data, null what we skip over.
      let a = addr;
      for (let n = 0; n < screen.size; n++) {
        if (screen.isFieldAttribute(a)) {
          const attr = screen.attributeAt(a)!;
          const isUnprotected = (attr & FA.PROTECT) === 0;
          if (isUnprotected) return screen.inc(a);
        } else if (wroteSinceOrder) {
          screen.setChar(a, 0x00);
        }
        a = screen.inc(a);
      }
      return 0; // unformatted: PT homes
    }

    case 'deferred':
      // SA/SFE/MF are parsed for length and ignored in stage 1. SFE and MF
      // define a field, so at minimum SFE must still plant an attribute or the
      // screen loses its structure; stage 1 hosts (MVS 3.8J, VM/370) do not
      // send them, and TN3270E will implement them properly.
      return addr;

    case 'structuredField':
      return addr;
  }
}

function requireOnScreen(screen: Screen, addr: number, what: string): void {
  if (addr < 0 || addr >= screen.size) {
    throw new ExecuteError(`${what} address ${addr} beyond buffer end ${screen.size - 1}`);
  }
}
