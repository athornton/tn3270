/**
 * `Transfer()` keyword parsing and IND$FILE command construction.
 *
 * The fourth and last of the units the design doc lays out
 * (docs/superpowers/specs/2026-08-18-indfile-cut-transfer-design.md): the codec
 * is `core/ft/cut.ts`, the frame layout `core/ft/frames.ts`, the state machine
 * `core/ft/transfer.ts`, and this is the operator-facing end — keywords in, a
 * validated request and a host command string out.
 *
 * NO I/O HAPPENS HERE. This module decides *what* to do; `runner.ts` drives the
 * session and `main.ts` supplies the file system through `TransferFiles`. That is
 * the same split Replay() already uses, and it is what makes every string this
 * module produces assertable in a unit test.
 *
 * Ported from x3270 4.5 `Common/ft.c`: `parse_ft_keywords` (:829-1000) is the
 * keyword table and its validation, and `ft_go` (:683-772) is the command
 * builder. Both are cited by line below, and every deliberate divergence says so.
 *
 * ## THE DIALECT SEAM
 *
 * The design doc's "Dialect seam" names exactly three host-dependent things:
 * command construction, the resync AID, and the `$` escape. The first two are the
 * `Dialect` interface here; the third is settled once for both dialects — see
 * `IND_FILE`. Everything else (codec, frames, state machine) is host-independent,
 * so adding CICS later is a third `Dialect` object and nothing else.
 *
 * TSO is the lead dialect today, not VM: the design doc's "MVS/TSO HOST FOUND"
 * and "PROTOCOL CONFIRMED" sections record that TK5's IND$FILE speaks CUT, needs
 * no Query List work, and has already had a real frame decoded out of it, while
 * VM/CMS remains blocked on Query List support. Hence `Host=tso` is the default
 * even though x3270's own default is also TSO for unrelated reasons (ft.c:320).
 */

import { AckAid, type TransferDirection } from '@tn3270/core';

/**
 * The file system, injected.
 *
 * `runner.ts` stays free of `node:fs` exactly as it is free of file I/O for
 * Replay() — main.ts owns that (see its comment at the `Replay` branch) — and a
 * test supplies an in-memory implementation instead of a temp directory. The four
 * operations are the whole of what a transfer needs.
 */
export interface TransferFiles {
  /** Does the destination already exist? Governs the `Exist` check. */
  exists(path: string): boolean;
  /** Read the whole source file for a `send`. Throws if unreadable. */
  read(path: string): Uint8Array;
  /** Create or truncate. Used for `Exist=keep` (on a missing file) and `replace`. */
  write(path: string, bytes: Uint8Array): void;
  /** Append. Used for `Exist=append`. */
  append(path: string, bytes: Uint8Array): void;
}

/** `Host=` — which host command dialect to speak. ft.c:147, `HT_TSO`/`HT_VM`. */
export type FtHostType = 'tso' | 'vm';
/** `Mode=` — ft.c:148. BINARY IS OUR DEFAULT; see `parseTransferKeywords`. */
export type FtMode = 'binary' | 'ascii';
/** `Cr=` — ft.c:149 (x3270 spells the list `auto remove add keep`). */
export type FtCr = 'auto' | 'remove' | 'add' | 'keep';
/** `Exist=` — ft.c:151. */
export type FtExist = 'keep' | 'replace' | 'append';
/** `Recfm=` — ft.c:152, minus its `default` spelling which means "unspecified". */
export type FtRecfm = 'fixed' | 'variable' | 'undefined';

/**
 * A validated transfer request: every keyword resolved, every default applied,
 * and every combination that cannot be expressed already rejected.
 *
 * The optional members are optional in the "the operator did not say" sense, and
 * absence is meaningful: no `recfm` means no `RECFM(...)` in the command, i.e.
 * let the host choose, which is x3270's `DEFAULT_RECFM` (ft_private.h:44).
 */
export interface TransferRequest {
  direction: TransferDirection;
  localFile: string;
  hostFile: string;
  host: FtHostType;
  mode: FtMode;
  cr: FtCr;
  exist: FtExist;
  recfm?: FtRecfm;
  lrecl?: number;
  blksize?: number;
}

/**
 * `Transfer()` failed before anything reached the host.
 *
 * A distinct class so the runner can tell "the operator typed something
 * impossible" from "the host refused", and so a test can assert the difference.
 * Both end up as an `error` reply; only the second one leaves the host in
 * transfer mode.
 */
export class TransferOptionError extends Error {
  constructor(message: string) {
    // "Transfer():" prefix as x3270 does, e.g. `popup_an_error(AnTransfer
    // "(): Unknown option: '%s'"` (ft.c:918).
    super(`Transfer(): ${message}`);
    this.name = 'TransferOptionError';
  }
}

/**
 * The program name, with the `$` that has to be EBCDIC `0x5B`.
 *
 * ## HOW THE `$` WAS VERIFIED, because a wrong byte here fails at the host with
 * no diagnostic
 *
 * x3270 does not type a literal `$`. It emits `"IND\\e005BFILE ..."` (ft.c:685)
 * and hands it to `emulate_input`, whose `\e` escape means "the following hex
 * digits are an EBCDIC code point" (kybd.c:4180, the `EBC` lexer state) — so
 * x3270 puts the byte `0x5B` on the wire and never consults a code page. The
 * design doc's dialect seam calls this out as item 3 and requires us to verify
 * the byte rather than trust a character round-trip.
 *
 * Verified three ways, all reproducible:
 *
 *  1. The generated table: `CP037_TO_UNICODE[0x5b]` is `0x0024`, i.e. `$`
 *     (packages/core/src/codepages/cp037.ts, row for bytes 0x58-0x5f).
 *  2. It is the ONLY entry that is `0x0024` — scanned all 256 — so
 *     `CodePage`'s reverse map cannot resolve `$` to anything else, whatever
 *     order it is built in. (That matters: the reverse map is built high byte to
 *     low so the lowest EBCDIC byte wins for characters with several encodings,
 *     codepage.ts:30-35. With a unique entry that rule never comes into play.)
 *  3. A test asserts `cp037.encode('IND$FILE')[3] === 0x5b`, and a second one
 *     asserts the byte that actually lands in the screen buffer after the
 *     keyboard has typed the command — the real wire path, since `Keyboard.type`
 *     is what `String()` and this action both go through.
 *
 * So the literal `$` here is safe, and there is a test that will fail if the code
 * page is ever swapped for one where it is not (cp1047, cp500 and friends all
 * keep `$` at 0x5B, but that is a fact about them, not a guarantee).
 */
export const IND_FILE = 'IND$FILE';

/**
 * The host-dependent half of a transfer: command syntax and the resync AID.
 *
 * The design doc's "Dialect seam" section is the specification for this
 * interface. Deliberately NOT a class hierarchy — there is no state and no
 * inheritance to share, and two object literals read better than two subclasses.
 */
export interface Dialect {
  readonly name: FtHostType;
  /** The full command line to type, WITHOUT a trailing newline. */
  buildCommand(req: TransferRequest): string;
  /**
   * The AID that resynchronises a confused transfer: Clear on VM,
   * PA2 on TSO (`ACK_RESYNC_VM`/`ACK_RESYNC_TSO`, ft_cut_ds.h:71-72).
   *
   * NOTHING SENDS THIS YET, and x3270 does not either — `grep -rn ACK_RESYNC`
   * over the whole 4.5 tree returns only the two `#define`s. It lives here
   * because the design doc names it as one of the three things a dialect owns,
   * and because a future resync path must not have to rediscover that the two
   * hosts differ.
   */
  readonly resyncAid: number;
}

/**
 * Shared body of both dialects' `buildCommand`.
 *
 * x3270 builds the whole line with one format string and three substitutions:
 *
 *     vb_appendf(&r, "IND\e005BFILE %s %s %s",
 *             p->receive_flag? "GET": "PUT",
 *             p->host_filename,
 *             (p->host_type != HT_TSO)? "(": "");     // ft.c:685-688
 *
 * — and then appends each option, the FIRST with no leading space and the rest
 * with one. That is where the two dialects' shapes come from, and they are not
 * symmetrical:
 *
 *   TSO  `IND$FILE GET 'A.B' ASCII CRLF RECFM(F) LRECL(80)`
 *   VM   `IND$FILE GET A B C (ASCII CRLF RECFM V LRECL 80`
 *
 * Note `(ASCII` with no space on VM: x3270's third substitution is the `(` and
 * the first option is appended straight onto it (`vb_appends(&r, "ASCII")`,
 * ft.c:690). Reproduced rather than tidied, because this is the string decades of
 * CMS hosts have been parsing.
 *
 * ONE COSMETIC DIVERGENCE: with no options at all, TSO's third substitution is
 * the empty string and x3270's line therefore ends in a space —
 * `"IND$FILE GET 'A.B' "`. We trim it. A trailing blank is invisible, is
 * discarded by every host command parser, and would make every expected string in
 * a test carry an unexplained space. It also costs one cell of the input field,
 * which `Runner`'s field-size pre-flight would then have to allow for. VM's line
 * ends in `(` and is unaffected.
 */
function buildIndFileCommand(req: TransferRequest, dialect: FtHostType): string {
  // GET is host->local. Naming trap 1 in the design doc: x3270's `receive_flag`
  // is the same direction as our `receive`, but its internal "upload"/"download"
  // vocabulary is the host's and is inverted from ordinary usage.
  const verb = req.direction === 'receive' ? 'GET' : 'PUT';
  const options: string[] = [];

  // `if (p->ascii_flag) vb_appends(&r, "ASCII")` (ft.c:689-690). BINARY IS THE
  // ABSENCE OF THE WORD, on both our hosts: the TK5 usage text lists only
  // `ASCII` among its options (design doc, "MVS/TSO HOST FOUND"), and x3270
  // emits an explicit `BINARY` only for CICS (ft.c:691-692), a dialect we do not
  // implement.
  if (req.mode === 'ascii') options.push('ASCII');
  if (wantsCrlf(req)) options.push('CRLF');

  // `if (p->append_flag && !p->receive_flag)` (ft.c:699-701). APPEND is a HOST
  // instruction, so it only makes sense on a PUT; for a GET, `Exist=append`
  // means "append to the local file" and never reaches the host.
  if (req.exist === 'append' && req.direction === 'send') options.push('APPEND');

  // `if (!p->receive_flag) { ... }` (ft.c:702-768). The whole DCB group is
  // send-only: on a GET the dataset already exists and its attributes are its
  // own. `parseTransferKeywords` rejects these keywords on a receive rather than
  // dropping them here, which is where x3270 silently drops them.
  if (req.direction === 'send' && req.recfm !== undefined) {
    if (dialect === 'tso') {
      // ft.c:704-726: " RECFM(" + letter + ")", then LRECL and BLKSIZE, each
      // parenthesised. Confirmed independently by the live TK5 usage text:
      // "RECFM(F|V|U) LRECL(nn) BLKSIZE(nn)".
      options.push(`RECFM(${recfmLetter(req.recfm)})`);
      if (req.lrecl !== undefined) options.push(`LRECL(${req.lrecl})`);
      if (req.blksize !== undefined) options.push(`BLKSIZE(${req.blksize})`);
    } else {
      // ft.c:750-765: " RECFM " + letter, then " LRECL %d". BARE, no parens, and
      // NO BLKSIZE — the VM branch has no blksize case at all, and
      // `parseTransferKeywords` therefore refuses `Blksize` with `Host=vm`
      // instead of accepting a keyword that would vanish.
      options.push(`RECFM ${recfmLetter(req.recfm)}`);
      if (req.lrecl !== undefined) options.push(`LRECL ${req.lrecl}`);
    }
  }

  const open = dialect === 'tso' ? '' : '(';
  return `${IND_FILE} ${verb} ${req.hostFile} ${open}${options.join(' ')}`.trimEnd();
}

/**
 * Does the command carry `CRLF`?
 *
 * `if (p->ascii_flag && p->cr_flag) vb_appends(&r, " CRLF")` (ft.c:694-695), with
 * `cr_flag` set by ft.c:940-952: `auto` means "follow the mode" (`p->cr_flag =
 * p->ascii_flag`), and any explicit value gives `remove || add`. So in ascii mode
 * every value except `keep` asks for CRLF, and in binary mode nothing does.
 *
 * `remove` and `add` produce the SAME command because the direction already says
 * which one the host will do — CRLF means "the other side uses CRLF line ends",
 * and a GET removes them while a PUT adds them. x3270 collapses them for exactly
 * this reason and we keep both spellings so an s3270 script reads correctly.
 */
function wantsCrlf(req: TransferRequest): boolean {
  return req.mode === 'ascii' && req.cr !== 'keep';
}

/** F, V or U (ft.c:707-719 for TSO; the VM branch has no U — see the caller). */
function recfmLetter(recfm: FtRecfm): string {
  switch (recfm) {
    case 'fixed': return 'F';
    case 'variable': return 'V';
    case 'undefined': return 'U';
  }
}

/**
 * MVS/TSO. The lead dialect: proven to speak CUT against a live TK5 host, with a
 * real frame decoded end to end (design doc, "PROTOCOL CONFIRMED").
 */
export const TSO_DIALECT: Dialect = {
  name: 'tso',
  buildCommand: (req) => buildIndFileCommand(req, 'tso'),
  resyncAid: AckAid.RESYNC_TSO,
};

/**
 * VM/CMS. Implemented and unit-tested, NOT yet exercised against a host: VM/370
 * CE needs Query List support before MECAFF will paint fullscreen at all (design
 * doc, "BLOCKER RESOLVED"). The seam exists so that when that lands, this object
 * is all that has to be right.
 */
export const VM_DIALECT: Dialect = {
  name: 'vm',
  buildCommand: (req) => buildIndFileCommand(req, 'vm'),
  resyncAid: AckAid.RESYNC_VM,
};

export function dialectFor(host: FtHostType): Dialect {
  return host === 'tso' ? TSO_DIALECT : VM_DIALECT;
}

// ---------------------------------------------------------------------------
// Keyword parsing
// ---------------------------------------------------------------------------

/**
 * The keyword names we accept, lower-cased for lookup.
 *
 * A Set rather than a bare list of `if`s so an unknown keyword can be reported
 * with the full accepted set — the operator's next move is to retype it, and
 * "unknown option 'Recfmt'" without the list is a guessing game.
 *
 * x3270's table (ft.c:142-166) has eight more: `Remap`, `Allocation`,
 * `PrimarySpace`, `SecondarySpace`, `Avblock`, `BufferSize`, `WindowsCodePage`
 * and `OtherOptions`. Each is deliberately absent, and absent LOUDLY (see
 * `parseTransferKeywords`): `Remap` and `BufferSize` govern behaviour we have not
 * built (ascii remapping and DFT), the space keywords need `SPACE(n,n)` and
 * `TRACKS|CYLS` command syntax nobody has tested against the host yet, and
 * `OtherOptions` is a hole through which any of them could arrive unvalidated.
 */
const KEYWORDS = [
  'direction', 'localfile', 'hostfile', 'host', 'mode', 'cr', 'exist',
  'recfm', 'lrecl', 'blksize',
] as const;

const KEYWORD_SET = new Set<string>(KEYWORDS);

/**
 * Resolve one enumerated value, case-insensitively and EXACTLY.
 *
 * WHERE WE ARE STRICTER THAN s3270, on purpose. x3270 prefix-matches values —
 * `strncasecmp(value, tp[i].keyword[k], strlen(value))` (ft.c:880-882) — so
 * `Mode=a` means ascii and `Cr=a` means `auto`, silently, because `auto` comes
 * first in its list and `add` never gets a chance. A one-letter abbreviation that
 * resolves to the wrong option is precisely the class of failure this action must
 * not have: `Mode=b` for binary and `Mode=a` for ascii differ by a silently
 * corrupted MODULE. Full spellings only, and an unrecognised one names the set.
 */
function enumValue<T extends string>(
  keyword: string,
  value: string,
  allowed: readonly T[],
): T {
  const lower = value.toLowerCase();
  const found = allowed.find((a) => a === lower);
  if (found === undefined) {
    throw new TransferOptionError(
      `invalid ${keyword} value '${value}' (expected ${allowed.join(', ')})`,
    );
  }
  return found;
}

/**
 * A positive integer, as x3270 requires for these keywords: `l = strtol(value,
 * &ptr, 10); if (l <= 0 || ptr == value || *ptr)` is an error (ft.c:894-900).
 *
 * `Number()` alone would accept `80.5`, `0x50`, `1e3` and `  80 `, all of which
 * would reach the host as something the operator did not type, so the digits are
 * checked with a regexp first.
 */
function positiveInt(keyword: string, value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new TransferOptionError(`${keyword} must be a positive integer, got '${value}'`);
  }
  const n = Number(value);
  if (n <= 0) throw new TransferOptionError(`${keyword} must be greater than zero`);
  return n;
}

/**
 * Parse `Transfer()` arguments into a validated request.
 *
 * ## SYNTAX: `keyword=value` ONLY
 *
 * s3270 also accepts `keyword,value` as two arguments (ft.c:865-877). We do not,
 * and cannot usefully: `commands.ts` splits arguments on commas AND spaces
 * (splitArgs, commands.ts:75-79), so `Transfer(Direction,send)` and
 * `Transfer(Direction=send, Mode=ascii)` arrive as indistinguishable token lists
 * and a parser that guessed would misread one of them. A bare token therefore
 * gets an error that says what to type instead.
 *
 * ## DEFAULTS, and the one that matters
 *
 * `Mode=binary` IS OUR DEFAULT AND IS NOT x3270's. x3270 defaults `ascii_flag`
 * to true (ft.c:321) — a text-first default from a world of card-image datasets.
 * The design doc's scope item 3 reverses it: "Binary by default, `Mode=ascii`
 * opt-in. A wrong default silently corrupts a MODULE; a wrong explicit choice is
 * visible in the command." The live TK5 IND$FILE agrees, defaulting to binary
 * itself and listing `ASCII` as an option. Everything else follows x3270:
 * `Direction=receive` (ft.c:319), `Host=tso` (ft.c:320), `Exist=keep`
 * (ft.c:324-325), `Cr=auto` (ft.c:322), and no RECFM/LRECL/BLKSIZE
 * (ft.c:326-329).
 *
 * ## AN UNKNOWN KEYWORD IS AN ERROR
 *
 * Not a warning, not a skip. x3270 agrees for a genuinely unknown keyword
 * (ft.c:917-919) but merely warns and continues for an invalid *resource* value
 * (`xs_warning("Invalid %s '%s', ignoring")`, ft.c:415). Dropping a keyword the
 * operator typed produces a transfer that does something they did not ask for —
 * a `Recfm` that never reached the host is a dataset with the wrong DCB, found
 * days later.
 */
export function parseTransferKeywords(args: readonly string[]): TransferRequest {
  const given = new Map<string, string>();

  for (const arg of args) {
    if (arg === '') continue; // a trailing comma; harmless
    const eq = arg.indexOf('=');
    if (eq < 0) {
      throw new TransferOptionError(
        `option '${arg}' needs a value, as keyword=value ` +
          `(e.g. Direction=send); the s3270 'keyword,value' form is not accepted`,
      );
    }
    // `if (eq == argv[j] || !*(eq + 1))` — neither side may be empty
    // (ft.c:858-863).
    const keyword = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    if (keyword === '') throw new TransferOptionError(`option '${arg}' has no keyword`);
    if (value === '') throw new TransferOptionError(`option '${keyword}' has no value`);

    const lower = keyword.toLowerCase();
    if (!KEYWORD_SET.has(lower)) {
      throw new TransferOptionError(
        `unknown option '${keyword}' (accepted: ${KEYWORDS.join(', ')})`,
      );
    }
    // A repeated keyword is an error rather than last-wins. x3270 overwrites
    // silently (`tp[i].value = NewString(value)`, ft.c:911), which means
    // `Mode=ascii,Mode=binary` transfers in binary with no hint that the first
    // one was discarded.
    if (given.has(lower)) {
      throw new TransferOptionError(`option '${keyword}' given more than once`);
    }
    given.set(lower, value);
  }

  const get = (k: string): string | undefined => given.get(k);

  const localFile = get('localfile');
  const hostFile = get('hostfile');
  // "Check for required values" (ft.c:993-1000), reported one at a time and
  // LocalFile first, as x3270 does.
  if (localFile === undefined) throw new TransferOptionError("missing 'LocalFile' option");
  if (hostFile === undefined) throw new TransferOptionError("missing 'HostFile' option");

  const direction = enumValue('Direction', get('direction') ?? 'receive', ['receive', 'send'] as const);
  const host = enumValue('Host', get('host') ?? 'tso', ['tso', 'vm'] as const);
  const mode = enumValue('Mode', get('mode') ?? 'binary', ['binary', 'ascii'] as const);
  const exist = enumValue('Exist', get('exist') ?? 'keep', ['keep', 'replace', 'append'] as const);

  const crText = get('cr');
  const cr = enumValue('Cr', crText ?? 'auto', ['auto', 'remove', 'add', 'keep'] as const);
  // `if (!p->ascii_flag) { popup_an_error(AnTransfer "(): Invalid 'Cr' option
  // for ASCII mode"); return NULL; }` (ft.c:944-947) — x3270's message reads
  // backwards but the rule is right: an explicit Cr in binary mode is a
  // contradiction, because CRLF translation only exists in ascii mode. `auto` is
  // exempt because it means "follow the mode", which binary mode answers.
  if (crText !== undefined && cr !== 'auto' && mode !== 'ascii') {
    throw new TransferOptionError(
      `Cr=${crText} needs Mode=ascii; in binary mode no line-end translation happens`,
    );
  }

  // `Recfm=default` is x3270's spelling for "unspecified" (ft.c:152, and
  // DEFAULT_RECFM at ft_private.h:44). Accepted so an s3270 script that says so
  // explicitly still runs, and mapped to absence.
  const recfmText = get('recfm');
  const recfmValue = recfmText === undefined
    ? undefined
    : enumValue('Recfm', recfmText, ['default', 'fixed', 'variable', 'undefined'] as const);
  const recfm: FtRecfm | undefined = recfmValue === undefined || recfmValue === 'default'
    ? undefined
    : recfmValue;

  const lreclText = get('lrecl');
  const blksizeText = get('blksize');
  const lrecl = lreclText === undefined ? undefined : positiveInt('Lrecl', lreclText);
  const blksize = blksizeText === undefined ? undefined : positiveInt('Blksize', blksizeText);

  // THREE COMBINATIONS x3270 ACCEPTS AND SILENTLY DROPS. Each one is rejected
  // here instead, because the visible symptom of the drop is a host dataset with
  // attributes nobody chose.
  //
  // 1. The DCB group on a receive: the whole block is inside
  //    `if (!p->receive_flag)` (ft.c:702), so a GET discards it.
  if (direction === 'receive') {
    for (const [k, present] of [['Recfm', recfm !== undefined], ['Lrecl', lrecl !== undefined], ['Blksize', blksize !== undefined]] as const) {
      if (present) {
        throw new TransferOptionError(
          `${k} applies to Direction=send only; on a receive the host dataset already exists`,
        );
      }
    }
  }
  // 2. Lrecl or Blksize without Recfm: x3270 nests both inside
  //    `if (p->recfm != DEFAULT_RECFM)` (ft.c:704, :721-726), so `Lrecl=80`
  //    alone emits nothing at all.
  if (recfm === undefined && (lrecl !== undefined || blksize !== undefined)) {
    throw new TransferOptionError(
      'Lrecl and Blksize need Recfm as well; the host ignores them without it',
    );
  }
  // 3. Blksize on VM, and Recfm=undefined on VM: the VM branch emits neither
  //    (ft.c:749-766 has no blksize case, and its recfm switch has only F and
  //    V — an undefined recfm there would emit the bare word `RECFM` with no
  //    letter after it, which is a malformed command rather than a default).
  if (host === 'vm') {
    if (blksize !== undefined) {
      throw new TransferOptionError('Blksize is a TSO option; CMS files have no block size');
    }
    if (recfm === 'undefined') {
      throw new TransferOptionError("Recfm=undefined is a TSO option; CMS supports fixed and variable");
    }
  }

  return {
    direction,
    localFile,
    hostFile,
    host,
    mode,
    cr,
    exist,
    // Conditional spreads, not `recfm: recfm`: with exactOptionalPropertyTypes an
    // explicit `undefined` is not the same as absence and does not typecheck.
    ...(recfm !== undefined ? { recfm } : {}),
    ...(lrecl !== undefined ? { lrecl } : {}),
    ...(blksize !== undefined ? { blksize } : {}),
  };
}

/**
 * Parse, then build the command — the two halves the runner needs, so that a
 * test can assert the exact string an argument list produces.
 */
export function transferCommand(args: readonly string[]): { request: TransferRequest; command: string } {
  const request = parseTransferKeywords(args);
  return { request, command: dialectFor(request.host).buildCommand(request) };
}
