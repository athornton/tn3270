/**
 * The file-transfer form's MODEL: fields, values, cycle order and applicability.
 *
 * PURE, and the same split as the keypad: `frontend/src/keypad.ts` owns the button table
 * while `tui/src/keypadOverlay.ts` renders it. Here the model is the data and
 * `tui/src/transferOverlay.ts` draws it, which is what makes stage 3 (the GUI) cheap --
 * it writes a renderer and reuses all of this.
 *
 * ## THE CENTRAL RULE: THIS FORM NEVER VALIDATES
 *
 * It collects STRINGS and hands them to `parseTransferKeywords`. The applicability rules
 * below are ERGONOMICS -- they stop a user entering a doomed combination -- but authority
 * lives in exactly one place. If these rules and the validator's ever disagree, THE
 * VALIDATOR WINS and the user sees its message. That is what keeps the TUI and the CLI
 * from drifting on what is legal, and it means this form cannot invent a legal-looking
 * combination the engine rejects.
 *
 * ## WHY UNSET IS A VALUE
 *
 * `Cr` and `Recfm` start at `''`, and that is not the same as any of their values: an
 * unset `Recfm` emits no `RECFM` keyword at all and lets the host choose, which is the
 * current CLI behavior that works on both hosts. A two-state F/V toggle would make "I did
 * not ask for record attributes" unexpressible.
 */

/** Which field. The ids are the tab order. */
export type TransferFieldId =
  | 'direction' | 'host' | 'localFile' | 'hostFile' | 'mode'
  | 'exist' | 'cr' | 'recfm' | 'lrecl' | 'blksize';

/** How a field takes input. `cycle` uses left/right; the others take printables. */
export type TransferFieldKind = 'cycle' | 'text' | 'numeric';

export interface TransferField {
  readonly id: TransferFieldId;
  readonly label: string;
  readonly kind: TransferFieldKind;
  /**
   * For a cycle field, the values in cycle order, `''` included where unset is legal.
   * Empty for text and numeric fields.
   *
   * `recfm`'s list here is the TSO one; `cycleField` drops `undefined` for VM. That
   * asymmetry lives in the cycle function rather than in two tables, so the VM rule has
   * one home. `exist`'s list is the receive one; a send drops `keep` the same way.
   */
  readonly values: readonly string[];
  /** Visible width for a text or numeric field. */
  readonly width: number;
}

/**
 * The fields in tab order.
 *
 * `lrecl` is 5 WIDE, NOT 3: `positiveInt` has no upper bound and TSO datasets
 * legitimately reach 32760, so a narrow field would silently prevent valid transfers.
 */
export const TRANSFER_FIELDS: readonly TransferField[] = [
  { id: 'direction', label: 'Direction', kind: 'cycle', values: ['receive', 'send'], width: 0 },
  { id: 'host', label: 'Host', kind: 'cycle', values: ['tso', 'vm'], width: 0 },
  { id: 'localFile', label: 'Local file', kind: 'text', values: [], width: 40 },
  { id: 'hostFile', label: 'Host file', kind: 'text', values: [], width: 40 },
  { id: 'mode', label: 'Mode', kind: 'cycle', values: ['binary', 'ascii'], width: 0 },
  { id: 'exist', label: 'Exist', kind: 'cycle', values: ['keep', 'replace', 'append'], width: 0 },
  { id: 'cr', label: 'Cr', kind: 'cycle', values: ['', 'auto', 'remove', 'add', 'keep'], width: 0 },
  { id: 'recfm', label: 'Recfm', kind: 'cycle', values: ['', 'fixed', 'variable', 'undefined'], width: 0 },
  { id: 'lrecl', label: 'Lrecl', kind: 'numeric', values: [], width: 5 },
  { id: 'blksize', label: 'Blksize', kind: 'numeric', values: [], width: 5 },
];

/**
 * The direction as the operator should READ it: both endpoints named, never a bare verb.
 *
 * ## THIS IS DISPLAY ONLY, AND THAT IS A HARD CONSTRAINT RATHER THAN A STYLE CHOICE
 *
 * `formKeywords` emits `Direction=${value}` from the STORED value, and `parseTransferKeywords`
 * validates against the literals `['receive', 'send']`. A renamed VALUE would emit
 * `Direction=send: local to host` and be refused by this project's own validator. So the stored
 * value stays `send`/`receive` and only what is DRAWN changes -- the same split the TUI's `shown()`
 * already uses for `''` -> `-`, and both `<select>` builders for `''` -> `(host default)`.
 *
 * ## WHY THIS EXISTS: IT COST A REAL FILE
 *
 * On 2026-10-07 the user -- an expert on this protocol, driving their own client -- read the bare
 * `send`/`receive` the wrong way round and OVERWROTE THEIR OWN `PROFILE EXEC A` on VM/370 under
 * `Exist=replace`. All four of this feature's guards defend against an EMPTY file reaching the
 * host; NONE covers a valid file hitting the wrong target. Naming the endpoints is the cheap half
 * of that gap. x3270 does not confirm a direction either, so the old behaviour was arguably
 * correct -- it was also one click from data loss.
 *
 * ## `local`, NOT `browser`
 *
 * The phrasing first proposed was `this browser`, which is right for the web gateway and WRONG for
 * the other two front ends: in the TUI and the Electron GUI, "local" is this machine's filesystem.
 * `local` is true in all three AND matches the `Local file` field label directly above it, so the
 * form reads as one statement rather than two vocabularies.
 *
 * ## NO ARROWS
 *
 * Fira Code and friends ligate `->` and `<-` -- `canvas/src/transferUi.ts` already took the arrows
 * out of a help line for exactly this -- and the TUI draws printable ASCII only (`tui/src/app.ts`),
 * so a real `->` or a U+2192 would force per-front-end text and defeat the point of one shared
 * mapping. `to` means the same thing in every renderer.
 *
 * AN UNRECOGNISED VALUE IS RETURNED UNCHANGED rather than falling through to `undefined`: every
 * renderer maps the values it offers through this, so a lookup without this property would draw a
 * blank menu entry if a third direction were ever added.
 */
export function directionLabel(value: string): string {
  if (value === 'send') return 'send: local to host';
  if (value === 'receive') return 'receive: host to local';
  return value;
}

const FIELD_BY_ID = new Map(TRANSFER_FIELDS.map((f) => [f.id, f]));

/** Every field's current string. `''` means unset, for every kind. */
export type TransferValues = Record<TransferFieldId, string>;

export interface TransferFormState {
  readonly values: TransferValues;
  /** Index into `TRANSFER_FIELDS`. */
  readonly selected: number;
  /**
   * The validator's message, when a submit was refused. Cleared on the next edit.
   *
   * Explicitly `| undefined` because `exactOptionalPropertyTypes` is on: without it the
   * spreads below cannot write `error: undefined` to clear it, and `app.ts` cannot
   * assign a `string | undefined` from a caught error into it either.
   */
  readonly error?: string | undefined;
}

/**
 * A fresh form.
 *
 * ## IT OPENS ON `send`, AND SO DOES THE KEYWORD PARSER -- ON PURPOSE, AS OF 2026-10-22
 *
 * The user's reason, recorded because it will look surprising to someone one day: **until VM has a
 * TCP/IP stack, this client is mostly used to GET SOFTWARE ONTO these systems** -- few people
 * actually develop software locally on a VM or MVS guest. Upload is the common case, so it is the
 * default.
 *
 * (The user's planned route to such a stack, which is the condition that would make this worth
 * revisiting: UTS -- v7 Unix -- plus an IUCV-alike backported to VM/370, a simple network driver
 * over a CTC pair cribbed from Linux on System/390 and z, and a small TCP stack running in UTS.
 * Hard on a PDP-11 for address-space reasons; not hard on S/370 with up to 16 MB. **If download
 * stops being the rare direction, reconsider this default.**)
 *
 * ## `parseTransferKeywords` ALSO DEFAULTS TO `send`, MATCHING THE FORM ON PURPOSE
 *
 * That default applies when a SCRIPT's `Transfer(...)` omits `Direction=`. An earlier revision kept
 * the two apart -- form `send`, parser `receive` -- reasoning that an unattended script has no label
 * to read. The user overruled that, 2026-10-22: a default should reflect what the tool is FOR
 * (PEOPLE ARE FAR MORE LIKELY TO USE IND$FILE TO GET SOFTWARE INTO a historic S/370 system than to
 * get it OUT), and a form/parser disagreement is its own trap for anyone who learns the tool
 * through the form and then writes a script. This diverges from x3270, which initialises
 * `receive_flag` true (`ft.c:319`); the other direction is still reachable by naming it.
 *
 * **The risk is real and is not softened anywhere:** a script written against x3270's default, or
 * against ours from before 2026-10-22, now means the OPPOSITE -- and under `Exist=replace` that
 * overwrites a host dataset. `transfer.test.ts` pins the parser's default (`DEFAULTS Direction TO
 * send, DIVERGING FROM x3270 ON PURPOSE`) so this cannot be "tidied" back into disagreement.
 *
 * ## ONE KNOCK-ON, AND IT IS VISIBLE
 *
 * `applicable` shows `Recfm` only on a send, so a fresh form now draws ONE MORE FIELD than it used
 * to. The TUI's box height is computed from the applicable count, so this is a layout change
 * there, not merely a value change. 27 tests across four files asserted the old default; each had
 * its SETUP updated rather than its assertion weakened.
 *
 * ## `exist` OPENS ON `replace`, BECAUSE THE FORM OPENS ON A SEND (2026-11-13)
 *
 * A send offers only `replace` and `append` (see `valuesFor`). It used to open on `keep`, which
 * reads as "don't overwrite" and did overwrite: only `append` reaches the host, and IND$FILE
 * replaced the file. A receive's default is still `keep`; `clearInapplicable` gives a send's
 * `keep` that default when the direction changes.
 */
export function newTransferForm(): TransferFormState {
  return {
    values: {
      direction: 'send', host: 'tso', localFile: '', hostFile: '',
      mode: 'binary', exist: 'replace', cr: '', recfm: '', lrecl: '', blksize: '',
    },
    selected: 0,
  };
}

/**
 * The values a cycle field offers, given the rest of the form.
 *
 * TWO state-dependent cases, kept here rather than as second tables so each rule has one home:
 *
 * - `recfm` on VM: `transfer.ts` records that "CMS supports fixed and variable", so
 *   `undefined` is not offered there.
 * - `exist` on a send: only `replace` and `append`. Only `append` reaches the host, as
 *   IND$FILE's `APPEND` (`transfer.ts`'s `transferCommand`); `keep` and `replace` both send
 *   nothing, and IND$FILE then REPLACES the host file. Offering `keep` there offered a
 *   protection that didn't exist (spec 2026-11-13). The keyword parser still accepts
 *   `Exist=keep` on a send, as x3270 does; only the form stops offering it.
 */
function valuesFor(id: TransferFieldId, values: TransferValues): readonly string[] {
  const field = FIELD_BY_ID.get(id);
  if (field === undefined) return [];
  if (id === 'recfm' && values.host === 'vm') {
    return field.values.filter((v) => v !== 'undefined');
  }
  if (id === 'exist' && values.direction === 'send') {
    return field.values.filter((v) => v !== 'keep');
  }
  return field.values;
}

/**
 * Move a cycle field by `delta`, wrapping, and clear anything the move made inapplicable.
 *
 * A no-op on a text or numeric field, so a caller may route left/right unconditionally.
 */
export function cycleField(
  state: TransferFormState, id: TransferFieldId, delta: number,
): TransferFormState {
  const field = FIELD_BY_ID.get(id);
  if (field === undefined || field.kind !== 'cycle') return state;
  const options = valuesFor(id, state.values);
  const at = options.indexOf(state.values[id]);
  // A value the current options no longer contain (Recfm=U when Host flipped to vm)
  // reads as index -1, and `(-1 + 1) % n` is 0 -- so it lands on the first option
  // rather than throwing. That is the same repair `clearInapplicable` performs.
  const next = options[(((at + delta) % options.length) + options.length) % options.length];
  return clearInapplicable({
    ...state,
    values: { ...state.values, [id]: next ?? '' },
    error: undefined,
  });
}

/** Replace a text or numeric field's contents. A no-op on a cycle field. */
export function setFieldText(
  state: TransferFormState, id: TransferFieldId, text: string,
): TransferFormState {
  const field = FIELD_BY_ID.get(id);
  if (field === undefined || field.kind === 'cycle') return state;
  // A numeric field takes digits only. Refusing the character is better than accepting it
  // and failing at submit: the validator's `positiveInt` would reject it, but the user
  // would not find out until they pressed Enter.
  if (field.kind === 'numeric' && !/^[0-9]*$/.test(text)) return state;
  if (text.length > field.width && field.kind === 'numeric') return state;
  return { ...state, values: { ...state.values, [id]: text }, error: undefined };
}

/**
 * Is this field meaningful, given the rest of the form?
 *
 * All five rules are derived from the validator's own behavior, cited where they come
 * from. An inapplicable field is not drawn and cannot be selected.
 */
export function applicable(id: TransferFieldId, values: TransferValues): boolean {
  switch (id) {
    // On a receive the dataset already exists, and x3270 silently drops these
    // (`ft.c:702`). Silently dropping is exactly what a form should make visible.
    case 'recfm':
      return values.direction === 'send';
    // `Lrecl=80` with no `Recfm` "emits nothing at all" (`ft.c:704,721-726`), so the
    // field would be a lie while Recfm is unset.
    case 'lrecl':
      return values.direction === 'send' && values.recfm !== '';
    // CMS files have no block size.
    case 'blksize':
      return values.direction === 'send' && values.recfm !== '' && values.host !== 'vm';
    // Carriage-return translation is meaningless on a binary transfer.
    case 'cr':
      return values.mode === 'ascii';
    default:
      return true;
  }
}

/**
 * Clear every value a state change has made inapplicable.
 *
 * INAPPLICABLE VALUES ARE CLEARED, NOT RETAINED INVISIBLY. A hidden value that breaks a
 * later submit is the worse failure: the user cannot see the field, cannot edit it, and
 * gets a validator error naming a keyword they never typed.
 *
 * ITERATED TO A FIXED POINT, because the rules CHAIN: clearing `recfm` (on a flip to
 * receive) makes `lrecl` and `blksize` inapplicable in turn, and a single pass reading
 * the values it is midway through mutating gets the wrong answer depending on table
 * order. `blksize` also depends on `recfm`, which is cleared LATER in tab order, so a
 * one-pass loop leaves it set. Two passes suffice for the current rules; the loop does
 * not assume that.
 */
function clearInapplicable(state: TransferFormState): TransferFormState {
  const values = { ...state.values };
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of TRANSFER_FIELDS) {
      if (!applicable(f.id, values) && values[f.id] !== '') {
        // Cycle fields whose unset value is not `''` (direction, host, mode, exist) are
        // never inapplicable, so this only ever clears an optional field.
        values[f.id] = '';
        changed = true;
      }
    }
    // Recfm=U surviving a flip to Host=vm is the other repair: the value stays legal for
    // TSO, so `applicable` does not catch it, but the VM dialect cannot express it.
    // Inside the loop because clearing it can cascade to Lrecl on the next pass.
    if (values.host === 'vm' && values.recfm === 'undefined') {
      values.recfm = '';
      changed = true;
    }
    // The same kind of repair for `Exist=keep` on a flip to send, which `valuesFor` doesn't
    // offer there. It becomes `replace`, a send's default. A value both directions offer
    // (`replace`, `append`) is kept, and a flip to receive needs nothing: it offers all three.
    if (values.direction === 'send' && values.exist === 'keep') {
      values.exist = 'replace';
      changed = true;
    }
  }
  return { ...state, values };
}

/**
 * The form as `Transfer()` keywords, ready for `parseTransferKeywords`.
 *
 * Only applicable, non-empty fields are emitted, so an unset `Recfm` contributes nothing
 * and the host chooses -- which is the whole reason unset is a distinct state.
 */
export function formKeywords(state: TransferFormState): string[] {
  const out: string[] = [];
  const keyword: Record<TransferFieldId, string> = {
    direction: 'Direction', host: 'Host', localFile: 'LocalFile', hostFile: 'HostFile',
    mode: 'Mode', exist: 'Exist', cr: 'Cr', recfm: 'Recfm',
    lrecl: 'Lrecl', blksize: 'Blksize',
  };
  for (const f of TRANSFER_FIELDS) {
    const value = state.values[f.id];
    if (value === '' || !applicable(f.id, state.values)) continue;
    out.push(`${keyword[f.id]}=${value}`);
  }
  return out;
}

/** The next selectable field index in `delta`'s direction, skipping inapplicable ones. */
export function moveField(state: TransferFormState, delta: number): TransferFormState {
  const n = TRANSFER_FIELDS.length;
  let at = state.selected;
  for (let i = 0; i < n; i++) {
    at = (((at + delta) % n) + n) % n;
    const field = TRANSFER_FIELDS[at];
    if (field !== undefined && applicable(field.id, state.values)) {
      return { ...state, selected: at };
    }
  }
  return state;
}

/**
 * The name a received file gets when nobody typed one (web receive spec, 2026-11-12). The web
 * gateway already used it for a receive whose `LocalFile` was empty.
 */
export const FALLBACK_LOCAL_NAME = 'download.bin';

/**
 * The local file name a received host file defaults to.
 *
 * - VM: `fn ft fm` becomes `fn.ft`. The filemode names a minidisk and isn't part of the file's
 *   name. A lone filename stays as it is.
 * - TSO: one pair of enclosing quotes is stripped and the rest is kept literally, so
 *   `'SYS1.PROCLIB(ASMHC)'` becomes `sys1.proclib(asmhc)`. Quotes that aren't balanced are kept.
 *   An unquoted name is used as typed: TSO would prefix the userid, but the default doesn't.
 * - Both are lowercased. Empty, blank or `''` gives `FALLBACK_LOCAL_NAME`.
 *
 * NO OS SANITIZING. Browsers sanitize download names themselves, and the GUI's native dialog
 * lets the operator edit the name before anything is written.
 *
 * ## WHY IT LIVES IN THIS FILE AND NOT IN A `transferName.ts` OF ITS OWN
 *
 * The plan put it in a new module. `canvas/src/transferUi.ts` needs it, and that module is
 * loaded by a browser through an import map that names exactly ONE frontend file, this one.
 * `transferUiModule.test.ts` pins that import list by exact equality, and
 * `gui/test/transferModule.test.ts` pins that this file has no runtime imports. The web gateway
 * also serves a fixed list of modules (`httpstatic.ts`). A second module would need entries in
 * both import maps and in that list, and missing one gives a blank window with no error. Putting
 * it here costs nothing.
 */
export function defaultLocalName(hostFile: string, host: string): string {
  const t = hostFile.trim();
  let name: string;
  if (host === 'vm') {
    // After the trim, splitting on runs of blanks leaves no empty words, and `''` splits to
    // `['']`, which joins back to `''`.
    name = t.split(/\s+/).slice(0, 2).join('.');
  } else {
    name = t.length >= 2 && t.startsWith("'") && t.endsWith("'") ? t.slice(1, -1).trim() : t;
  }
  name = name.toLowerCase();
  return name === '' ? FALLBACK_LOCAL_NAME : name;
}
