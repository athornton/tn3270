import { WCC, FA, Order, XA, XA_3270 } from '../constants.js';
import type { Screen } from '../screen.js';
import type { ParsedRecord, Token, CommandName } from './parse.js';
import { isQueryRequest, queryListRequest } from './sf.js';
import type { QueryRequest } from '../queryreply.js';

/**
 * The running character-attribute state an SA order maintains.
 *
 * A MAP BY TYPE, not a single value, because the manual requires a composite:
 * "The set of type-value pairs applied during character processing is a
 * composite, by attribute type, of the last value specified in previously
 * encountered SA orders" (p. 4-7, pages.txt:2995-2996). One value would make an
 * SA colour silently clear a preceding SA highlighting.
 *
 * Lives for one write command and is discarded: "Another write type command is
 * sent" returns the set to defaults (p. 4-6, pages.txt:2978), which x3270 does by
 * zeroing default_fg/bg/gr at the top of write processing (ctlr.c:1414-1416).
 * Declared inside `execute` for exactly that reason — module scope would leak it
 * between records, which is reset trigger 2 silently not happening.
 *
 * The Clear key — the manual's third trigger (pages.txt:2979) — resets it
 * through Screen.clear() instead, because Clear originates locally rather than in
 * a datastream, so there is no SaState alive to reset when it happens. The fourth
 * trigger is a power switch.
 *
 * A MEMBER'S ABSENCE IS LOAD-BEARING, and is not the same as a zero: absent means
 * "this type is at its default, write nothing", where 0x00 under FOREGROUND is
 * `XAC_DEFAULT`, a value the host legitimately set. `delete` rather than `= 0` in
 * the reset paths below for that reason.
 */
interface SaState {
  fg?: number;
  bg?: number;
  gr?: number;
}

/**
 * Every attribute type back to its default.
 *
 * `delete`, not `= 0`: absence means "unspecified", where 0x00 is a value the host
 * can legitimately set. See the note on SaState. Shared by the SA X'00' handler,
 * the plain-SF reset, and the SFE baseline.
 */
function resetSa(sa: SaState): void {
  delete sa.fg;
  delete sa.bg;
  delete sa.gr;
}

/**
 * What each SA attribute type does to the running state.
 *
 * A TABLE RATHER THAN A SWITCH because two callers need the same answer and they
 * MUST NOT DRIFT: the `'deferred'` case decides what to apply, and the token loop
 * decides what to count in `setAttributeIgnored`. With the membership test written
 * out separately, adding a fifth type to one and forgetting the other would make
 * that counter report applied work as dropped — the exact silent lie its contract
 * exists to rule out. Here `saTypeImplemented` is *derived* from this table, so
 * adding an entry updates both callers at once and forgetting is not possible.
 *
 * Same motive as the `_never` guard in the token loop: make the failure a
 * structural impossibility rather than something a reviewer has to notice.
 */
const SA_HANDLERS: Readonly<Record<number, (sa: SaState, value: number) => void>> = {
  // "All character attributes reset all character attribute types that are
  // specifiable in the SA order to their default value. Attribute types affected
  // are color, highlighting, and character set" (p. 4-18, pages.txt:3450-3452) —
  // so ALL types, not one. Twelve of these are in the committed TK5 fixture, so
  // this path is live. Character set is among the types reset and we store none,
  // so there is nothing to drop for it. x3270 zeroes all five of its defaults in
  // its XA_ALL arm (ctlr.c:1915-1921).
  //
  // The value is ignored deliberately: "The only valid value setting is X'00'; all
  // others are reserved" (pages.txt:3452). x3270 does not look at it either.
  [XA.RESET]: (sa) => { resetSa(sa); },
  // These three store the VALUE the host sent, INCLUDING 0x00 — which under them
  // is XAC_DEFAULT/XAH.DEFAULT, "device default", a legitimate setting and NOT a
  // reset. See the TYPE-vs-VALUE warning in constants.ts.
  [XA.FOREGROUND]: (sa, value) => { sa.fg = value; },
  [XA.BACKGROUND]: (sa, value) => { sa.bg = value; },
  [XA.HIGHLIGHTING]: (sa, value) => { sa.gr = value; },
};

/**
 * Does the SA order apply this attribute type, or drop it?
 *
 * Derived from `SA_HANDLERS` so it cannot disagree with what is actually applied.
 * `XA.CHARSET` (Programmable Symbol Sets, out of scope) and anything unrecognised
 * are false, and stay counted by `setAttributeIgnored`.
 */
function saTypeImplemented(type: number): boolean {
  return Object.hasOwn(SA_HANDLERS, type);
}

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
  /**
   * The host asked what this terminal can do, and we should answer.
   *
   * Carries WHICH request it was, not just that one happened: a plain Query and
   * the three Query List versions produce different sets of units, and the
   * session cannot tell them apart from a bare flag. This replaced the string
   * literal 'queryReply' when Query List landed.
   *
   * The DECISION of which units to send is not made here — it belongs with the
   * capability list in queryreply.ts, which owns the Table 6-1 rules. This field
   * carries the request; selectCapabilities interprets it.
   */
  sfReply?: QueryRequest;
  /** WCC bit 6: unlock the keyboard. */
  keyboardRestore: boolean;
  /**
   * This command releases the enter-inhibit condition raised by a Query.
   *
   * Distinct from keyboardRestore, and deliberately so. keyboardRestore is the
   * host asking, via WCC bit 6, to unlock EVERYTHING; this is the far narrower
   * "a write happened, so the screen the Query froze is no longer frozen", and
   * it holds whether or not the WCC sets that bit. The session applies each
   * separately.
   *
   * True for exactly four commands, which are exactly the four x3270 clears
   * KL_ENTER_INHIBIT on:
   *
   *   - Erase/Write and Erase/Write Alternate, via ctlr_erase's opening
   *     `kybd_inhibit(false);` (Common/ctlr.c:546-550); process_ds routes both
   *     there, `case CMD_EWA: ... ctlr_erase(true);` and `case CMD_EW: ...
   *     ctlr_erase(false);` (ctlr.c:615-625).
   *   - Erase All Unprotected, via ctlr_erase_all_unprotected (ctlr.c:1303-1309).
   *   - Write, via ctlr_write (ctlr.c:1406). Note this one covers all three
   *     write commands, since process_ds calls ctlr_write after ctlr_erase for
   *     EW and EWA too — hence EW/EWA clear it twice in x3270, harmlessly.
   *
   * And false for everything else, which is what makes the inhibit outlast a
   * read: process_ds sends CMD_RB/RM/RMA to ctlr_read_buffer/ctlr_read_modified,
   * CMD_WSF to write_structured_field, and CMD_NOP to a trace line and nothing
   * else (ctlr.c:632-657) — none of the three clearing functions among them.
   */
  releasesEnterInhibit: boolean;
  /** WCC bit 5: sound the alarm. */
  alarm: boolean;
  /** WCC bit 4 asked for a local copy and we have no printer. */
  printerUnavailable: boolean;
  /** How many structured fields we skipped, for the trace. */
  structuredFieldsIgnored: number;
  /**
   * SA orders parsed and dropped — the ones whose attribute TYPE we do not
   * implement, which is `XA.CHARSET` and anything unrecognised.
   *
   * NOT a count of SA orders seen. Colour, background, highlighting and the
   * X'00' reset are applied now, and counting those would break what this field
   * is for: a zero must keep meaning "we never saw one we had to throw away"
   * rather than "we stopped looking". The session reports it as dropped work
   * (session.ts:250-252), so an applied order appearing here would be a false
   * report of a gap.
   *
   * Per-record, and nothing sums these across a session: the live run measures
   * SA and MF by grepping the trace for `deferred(0x28` / `deferred(0x2c`
   * (parse.ts describeRecord emits them), which is what aggregates.
   */
  setAttributeIgnored: number;
  /**
   * MF orders parsed and dropped.
   *
   * A NONZERO VALUE HERE IS A FOLD-INTO-2B SIGNAL: MF modifies an existing
   * field's attributes, so ignoring one can leave a field's protection stale
   * and the operator unable to type where they should. See the stage 2a spec.
   * Measured via the trace grep, as for setAttributeIgnored above.
   */
  modifyFieldIgnored: number;
  /** Set when a recoverable protocol fault occurred. */
  programCheck?: string;
}

export function execute(screen: Screen, record: ParsedRecord): ExecuteResult {
  const result: ExecuteResult = {
    keyboardRestore: false,
    releasesEnterInhibit: false,
    alarm: false,
    printerUnavailable: false,
    structuredFieldsIgnored: 0,
    setAttributeIgnored: 0,
    modifyFieldIgnored: 0,
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
      // Redundant against keyboardRestore just above, which already unlocks
      // everything — set anyway so the flag means "this command releases the
      // inhibit" for all four commands uniformly, rather than "…except where
      // some other flag happens to cover it". x3270 is equally redundant here:
      // ctlr_erase_all_unprotected calls kybd_inhibit(false) at its top
      // (ctlr.c:1309) and do_reset(false) at its bottom (ctlr.c:1350), and the
      // latter clears the same bit again (kybd.c:2062).
      result.releasesEnterInhibit = true;
      return result;

    case 'WriteStructuredField':
      for (const t of record.tokens) {
        if (t.kind !== 'structuredField') continue;
        // Two predicates, not one, and both check the PID. isQueryRequest is a
        // plain Query (TYPE=0x02); queryListRequest is a Query List (0x03) and
        // hands back its REQTYP and QCODE list. They are kept separate because
        // the replies differ — see the note on isQueryRequest in stream/sf.ts.
        //
        // The subsetting rules span p. 6-19 AND p. 6-20, not p. 6-19 alone.
        // p. 6-19 introduces the selector — "an additional parameter, REQTYP
        // (Request Type), bits 0-1 of byte 5 and, / optionally, a list of
        // QCODES starting at byte 6" (pages.txt:8508-8509) — and the rules for
        // each of its three values are the table on p. 6-20. Those rules are
        // implemented in queryreply.ts selectCapabilities, which is where the
        // capability list they filter lives; this case only classifies.
        //
        // WHY THIS MATTERS FOR VM: VM/370's MECAFF IND$FILE asks with a Query
        // List, not a Query, and waits for a reply. While this branch counted
        // 0x03 as ignored, file transfer on VM/CMS hung forever. MVS/TSO sends a
        // plain Query and was unaffected.
        const list = queryListRequest(t.field);
        if (isQueryRequest(t.field)) {
          result.sfReply = { kind: 'query' };
        } else if (list !== undefined) {
          result.sfReply = { kind: 'queryList', reqtyp: list.reqtyp, qcodes: list.qcodes };
        } else {
          // Everything else: a read against a real partition (non-0xFF PID on a
          // query, which x3270 rejects at sf.c:230-251), a TYPE we do not
          // implement, or an SFID we do not implement. Counted and traced rather
          // than answered — an unanswered request is honest; a guessed answer is
          // not.
          //
          // Counted rather than program-checked, which is where we knowingly
          // diverge from x3270: it returns PDS_BAD_CMD for a bad PID, and under
          // TN3270E that becomes a negative response (telnet.c:3432-3436). We
          // negotiate no TN3270E yet, so there is nowhere to send one, and
          // dropping the session over a field we can simply ignore would be
          // worse behaviour than the trace line. Revisit with stage 2b.
          result.structuredFieldsIgnored++;
        }
      }
      return result;

    case 'EraseWrite':
    case 'EraseWriteAlternate':
      // On a model 2 the alternate size equals the default, so both clear the
      // same buffer. TN3270E gives them different behavior.
      screen.clear();
      result.releasesEnterInhibit = true;
      break;

    case 'Write':
      result.releasesEnterInhibit = true;
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
  // Fresh per write command, and deliberately not per session; see SaState.
  // This declaration IS reset trigger 2.
  const sa: SaState = {};

  for (const token of record.tokens) {
    // Tally the orders we drop, here rather than in applyToken because
    // applyToken has no access to the result.
    //
    // The commands that return before this loop cannot deliver a deferred token
    // that matters: WSF parses to structuredField tokens only, and NoOp, EAU and
    // Read Buffer/Read Modified/Read Modified All carry no data field at all
    // (NOP is "sent with no WCC or data", pages.txt:1730; EAU's format at
    // pages.txt:1951-1958 has no data field), so an SA or MF riding along in one
    // is a malformed record the real hardware would never see. Deferred tokens
    // on those six paths therefore go uncounted, and that is the whole of the
    // gap — verified by walking every case in the switch above.
    // An exhaustive switch, not an if/else chain: 8017c49 narrowed
    // deferred.order to SA|MF, so the never guard turns "a third deferred order
    // was added and nothing counts it" into a compile error. Without it such an
    // order would be silently uncounted, and a zero here would then mean "we
    // never saw one" when it actually meant "we never looked" — the precise
    // failure these counters exist to rule out.
    if (token.kind === 'deferred') {
      switch (token.order) {
        case Order.SA:
          // ONLY the types still dropped, now that four of them are applied
          // below. Counting an implemented type would make a nonzero here mean
          // "some SA arrived" rather than "an SA was thrown away", and the
          // session's trace line (session.ts:250-252) reports it as the latter.
          // The predicate is shared with the case that does the applying, so the
          // two cannot drift; see saTypeImplemented.
          if (!saTypeImplemented(token.data[0]!)) result.setAttributeIgnored++;
          break;
        case Order.MF: result.modifyFieldIgnored++; break;
        default: { const _never: never = token.order; void _never; }
      }
    }
    addr = applyToken(screen, token, addr, () => { wroteSinceOrder = true; }, wroteSinceOrder, sa);
    if (token.kind !== 'data' && token.kind !== 'ge' && token.kind !== 'ra') {
      wroteSinceOrder = false;
    }
  }

  return result;
}

/**
 * Stamp the running SA state onto a cell just written.
 *
 * Called after `setChar`, never before: `setChar` deliberately leaves extended
 * attributes alone (see its comment) precisely so this can run second.
 *
 * CLEARS FIRST, and that is not redundant. "Character attributes are associated
 * with a character and not with the character's position in the buffer. Thus,
 * whenever a character is overwritten by a new character (or cleared or erased),
 * the old character attribute is overwritten by the character attribute of the
 * new character" (p. 4-16, pages.txt:3388-3390). `Screen.setExtended` MERGES, to
 * serve the composite rule, so merging the state alone would leave a previous
 * record's colour on a cell this record has just overwritten. x3270 has no such
 * hazard because it stamps all three unconditionally (ctlr.c:2141-2143) through
 * `ctlr_add_fg`, whose `ea_buf[baddr].fg = color` assigns rather than merges
 * (ctlr.c:2852-2867) — so the clear here is what makes this an assignment,
 * matching x3270 exactly.
 *
 * Note the consequence: this must NOT short-circuit when the state is empty. An
 * empty state means "default", and stamping a default over a stale attribute is
 * the whole point.
 */
function applySa(screen: Screen, addr: number, sa: SaState): void {
  screen.clearExtended(addr);
  screen.setExtended(addr, sa);
}

function applyToken(
  screen: Screen,
  token: Token,
  addr: number,
  markWrote: () => void,
  wroteSinceOrder: boolean,
  sa: SaState,
): number {
  switch (token.kind) {
    case 'sba':
      requireOnScreen(screen, token.address, 'SBA');
      return token.address;

    case 'sf':
      screen.setFieldAttribute(addr, token.attr);
      // "If the display receives an SF order, it sets the associated extended
      // field attribute to its default value" (p. 4-4, pages.txt:2869-2870), so
      // the running state returns to unspecified — otherwise a field following a
      // coloured one inherits colour the host never gave it. setFieldAttribute
      // has already cleared the attribute CELL's own extended attributes; this is
      // the running-state half of the same rule, and both halves are needed.
      // x3270 does both too: START_FIELD zeroes the cell's fg/bg/gr
      // (ctlr.c:1394-1398) but leaves default_fg alone — its equivalent of the
      // running-state half is that it never seeds default_* from a field at all.
      resetSa(sa);
      return screen.inc(addr);

    case 'ic':
      screen.cursor = addr;
      return addr;

    case 'data': {
      let a = addr;
      for (const b of token.bytes) {
        screen.setChar(a, b);
        applySa(screen, a, sa);
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
      // A GE character carries the running attributes like any other character;
      // x3270 stamps default_fg/bg/gr on it identically (ctlr.c:1739-1741).
      applySa(screen, addr, sa);
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
        // RA-filled positions are "subsequently interpreted characters" and take
        // the running attributes; x3270 stamps them per fill iteration inside its
        // own do-while (ctlr.c:1669-1671).
        applySa(screen, a, sa);
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
          // NOT applySa: EUA nulls rather than writes, so it must not stamp the
          // running state — it clears instead. "Field attributes and extended
          // field attributes are not affected by EUA. Character attributes for
          // every character changed to nulls are reset to their defaults" (p.
          // 4-11, pages.txt:3165-3166). Needed as its own call because setChar
          // deliberately leaves extended attributes alone; without it a nulled
          // cell keeps the colour of the character that used to be there.
          screen.clearExtended(a);
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
          // Same rule as EUA above, and stated for PT explicitly: "The PT order
          // resets the character attribute to its default value for each
          // character set to nulls" (p. 4-9, pages.txt:3090-3091). x3270 zeroes
          // fg, bg and gr beside the null (ctlr.c:1555-1560). Guarded by
          // wroteSinceOrder along with the null itself, because a PT that
          // "immediately follows a command, order, or order sequence" leaves the
          // buffer unmodified (pages.txt:3088-3089) — and an attribute is buffer
          // content.
          screen.clearExtended(a);
        }
        a = screen.inc(a);
      }
      return 0; // unformatted: PT homes
    }

    case 'sfe': {
      // SFE DEFINES A FIELD. The 0xC0 pair carries the basic field attribute; the
      // colour and highlighting pairs become the field's EXTENDED FIELD ATTRIBUTE,
      // stored on the attribute cell, and also seed the running SA state — see the
      // two uses at the bottom of this case. 0x43 character set is still dropped —
      // Programmable Symbol Sets are out of scope — as is anything else.
      //
      // A missing 0xC0 pair does NOT mean "no field": p. 4-5 says unspecified
      // attribute types take their defaults, so the field exists with attribute
      // 0x00 (unprotected, unintensified, MDT clear). Skipping it would lose
      // the field, which is the failure SFE is implemented to prevent. x3270
      // does exactly this, ctlr.c:1883-1885: `if (!any_fa) { START_FIELD(0); }`
      // — note 0, not FA.PRINTABLE, even though a real host's plain unprotected
      // field arrives as 0xC0.
      //
      // findLast, not find: p. 4-5 (pages.txt:2899-2901, OCR intact) says "All
      // attribute types and values are checked for validity. If the same
      // attribute / type-value pair appears more than once, the last
      // specification for a repeated / attribute type takes effect." x3270 gets
      // this for free by calling START_FIELD on every 0xC0 it walks past
      // (ctlr.c:1838-1842), so its last one is the one left in the buffer.
      const basic = token.pairs.findLast((p) => p.type === XA_3270);
      screen.setFieldAttribute(addr, basic?.value ?? 0x00);

      // Collect the extended pairs once; they are used for two different things
      // below. In pair order, assigning as it goes, so a repeat resolves to the
      // last one: "All attribute types and values are checked for validity. If
      // the same attribute type-value pair appears more than once, the last
      // specification for a repeated attribute type takes effect" (p. 4-5,
      // pages.txt:2899-2901). Same rule as findLast above, by a different means —
      // findLast is needed there because setFieldAttribute is called once.
      //
      // XA.RESET is deliberately NOT handled: "The attribute type X'00' can
      // appear only in the SA order" (p. 4-18, pages.txt:3456), so in an SFE it is
      // not a reset but an invalid type, and invalid types "are rejected"
      // (pages.txt:2897-2898) — i.e. ignored, leaving the other pairs to stand.
      // x3270 agrees: its SFE arm for XA_ALL traces the pair and advances past it
      // without touching efa_fg/bg/gr (ctlr.c:1869-1871), where its SA arm for the
      // same type zeroes all five defaults (ctlr.c:1915-1921). An earlier draft
      // treated it as a reset here, which would have let a trailing X'00' silently
      // discard a colour the host did set.
      const efa: SaState = {};
      for (const p of token.pairs) {
        if (p.type === XA.FOREGROUND) efa.fg = p.value;
        else if (p.type === XA.BACKGROUND) efa.bg = p.value;
        else if (p.type === XA.HIGHLIGHTING) efa.gr = p.value;
      }

      // USE ONE: store them on the FIELD ATTRIBUTE CELL, which is where the
      // EXTENDED FIELD ATTRIBUTE lives. This is the level a character attribute
      // falls back to: "If there are field attributes in the character buffer and
      // if a character attribute specifies default for any character property
      // (color, highlighting, or character set), the character is displayed using
      // the value of that property established for the field in the extended field
      // attribute. Otherwise, the character attribute overrides the field
      // attribute" (p. 4-16, pages.txt:3383-3387).
      //
      // WITHOUT THIS THE FIELD'S COLOUR IS UNRECOVERABLE. The running state below
      // only reaches characters written in THIS record; a later record that
      // overwrites one character mid-field, with no SFE and no SA, correctly
      // clears that character's own attribute (pages.txt:3388-3392) and would then
      // have nothing to fall back on — one colourless cell between coloured
      // neighbours, inside a field the host still defines as coloured.
      //
      // The FA cell is exactly where x3270 puts them, immediately after its pair
      // loop: `ctlr_add_fg(buffer_addr, efa_fg)` and siblings at ctlr.c:1886-1889,
      // with buffer_addr still on the attribute position (it increments at :1891).
      // Its renderer reads them straight back off that cell — `if (xea[i].fg)
      // fa_fg = xea[i].fg & 0x0f; else fa_fg = color_from_fa(fa)`
      // (fprint_screen.c:581-585), then falls back to it per character at :754-758.
      //
      // Safe to write unconditionally: setFieldAttribute above has just cleared
      // this cell (pages.txt:2869-2870), so an empty `efa` leaves it clean rather
      // than inheriting the previous field's colour. CONSUMING this fallback is
      // Task 5's job in render.ts; storing it is this task's.
      screen.setExtended(addr, efa);

      // USE TWO: seed the RUNNING SA STATE, so the pairs also reach every
      // character this field contains. That is how a field-level attribute and a
      // character-level SA compose: the field sets the baseline, a later SA in
      // the same record overrides it, and the next SF/SFE replaces the baseline.
      //
      // A DELIBERATE DIVERGENCE FROM X3270, which seeds no running state from SFE
      // at all — no default_* assignment appears anywhere in its SFE case — and
      // instead relies entirely on the per-cell fallback to the FA cell above. We
      // do both, so a cell written under a coloured SFE carries the colour
      // directly. That is redundant for rendering but not wrong (the manual makes
      // the character attribute authoritative when set, pages.txt:3386-3387), and
      // it keeps the SFE-then-SA precedence tests meaningful. Storing it in both
      // places is what makes the fallback available when the character attribute
      // is later cleared.
      //
      // RESET FIRST, unconditionally, so a plain SFE behaves like a plain SF: an
      // SFE that names no colour must leave the state at default rather than
      // inheriting the previous field's, because "unspecified attribute types
      // take their default values" (p. 4-5). x3270 does this by zeroing
      // efa_fg/efa_bg/efa_gr before its pair loop (ctlr.c:1827-1832) rather than
      // carrying them in.
      resetSa(sa);
      Object.assign(sa, efa);
      return screen.inc(addr);
    }

    case 'deferred': {
      // MF is still unimplemented and still counted; see modifyFieldIgnored.
      if (token.order === Order.MF) return addr;

      // SA. token.data is exactly [type, value] (parse.ts:240-246). An absent
      // handler is a type we do not implement, which the token loop has already
      // counted via saTypeImplemented — the same table, so the two cannot disagree.
      SA_HANDLERS[token.data[0]!]?.(sa, token.data[1]!);
      return addr;
    }

    case 'structuredField':
      return addr;
  }
}

function requireOnScreen(screen: Screen, addr: number, what: string): void {
  if (addr < 0 || addr >= screen.size) {
    throw new ExecuteError(`${what} address ${addr} beyond buffer end ${screen.size - 1}`);
  }
}
