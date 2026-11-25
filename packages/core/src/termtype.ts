import { TERMINAL_TYPE, MODEL_2, MODEL_3, MODEL_4, MODEL_5 } from './constants.js';

/**
 * Terminal type resolution for the telnet TERMINAL-TYPE subnegotiation.
 *
 * The `-E` suffix means EXTENDED DATA STREAM, a 3270 capability claim inside
 * the terminal-type string. It is NOT the TN3270E telnet option (40), which is
 * stage 2b; conflating the two produced a wrong diagnosis once already.
 *
 * MVS 3.8j TSO rejects a bare IBM-3278-2 with IKT00405I and accepts
 * IBM-3278-2-E, but claiming -E invites a Read Partition (Query) that must be
 * answered — hence Query Reply landing in the same stage.
 */

export class TerminalTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalTypeError';
  }
}

/** A model: what to call it on the wire, and what its alternate size is. */
export interface Model {
  readonly ttype: string;
  /**
   * The ALTERNATE (Erase/Write Alternate) size. The default size is 24x80 for
   * every model -- see the note on MODEL_3 in constants.ts -- so this is the only
   * geometry a model number actually decides.
   */
  readonly alternate: { readonly rows: number; readonly cols: number };
}

/**
 * Model number to wire name and alternate size.
 *
 * Sizes per x3270 `include/3270ds.h:446-453`. Models 3, 4 and 5 were held back
 * until the screen could switch size on Erase/Write Alternate, because claiming
 * one is a promise to the host that it may do exactly that.
 *
 * NOT here: `IBM-DYNAMIC`, which is not a model but "ask me via Query Reply", and
 * which x3270 sends only for oversize (`telnet.c:2100`, `create_3270_termtype`).
 * Oversize and IBM-DYNAMIC now live in `geometry.ts`, which builds on this table
 * rather than duplicating it (see `resolveGeometry`, which calls `resolveTerminalType`
 * and `resolveAlternateSize` below); this table stays the models only.
 *
 * Keys are uppercase because lookups are case-folded; see resolveTerminalType.
 */
/**
 * x3270's model names (`Common/model.c:68-101`, `canonical_model_x`): after an optional `IBM-`, a
 * bare `2`-`5` or `327[89]-[2345]`, optionally `-E` (a bare N takes no -E). `3279` and a bare
 * number are COLOR, `3278` is MONO (`*is_color = (*colorp == '9')`, default `'9'`). Unlike x3270,
 * which ignores a name's `-E` (its extended data stream is the `extendedDataStream` resource),
 * ours selects it, as it always has.
 */
export interface ParsedModel {
  readonly number: 2 | 3 | 4 | 5;
  readonly color: boolean;
  readonly extended: boolean;
}

export function parseModel(name: string): ParsedModel | undefined {
  const folded = name.toUpperCase();
  const bare = folded.startsWith('IBM-') ? folded.slice(4) : folded;
  const m = /^(?:327([89])-)?([2-5])(-E)?$/.exec(bare);
  if (m === null) return undefined;
  if (m[1] === undefined && m[3] !== undefined) return undefined;
  return { number: Number(m[2]) as 2 | 3 | 4 | 5, color: m[1] !== '8', extended: m[3] !== undefined };
}

const ALTERNATE = { 2: MODEL_2, 3: MODEL_3, 4: MODEL_4, 5: MODEL_5 } as const;

/**
 * The advertised type, `create_3270_termtype` (`Common/telnet.c:2095-2108`): `IBM-3279-N` only for
 * a COLOR model 2 or 3, else `IBM-3278-N`; `-E` when extended. (`IBM-DYNAMIC` for oversize is
 * `geometry.ts`'s.) `mono` is x3270's `-mono`, which makes every model mono (`model.c:155`).
 */
export function advertisedType(p: ParsedModel, mono = false): string {
  const color = p.color && !mono;
  return `IBM-327${color && p.number < 4 ? '9' : '8'}-${p.number}${p.extended ? '-E' : ''}`;
}

/** The canonical names, 3279 (color) first, then 3278 (mono): what the dialog and menu list. */
export const KNOWN_MODELS: Readonly<Record<string, Model>> = Object.fromEntries(
  (['9', '8'] as const).flatMap((c) => ([2, 3, 4, 5] as const).flatMap((n) => ['', '-E'].map((e) => {
    const name = `327${c}-${n}${e}`;
    return [name, { ttype: advertisedType(parseModel(name)!), alternate: ALTERNATE[n] }] as const;
  }))),
);

/**
 * The model a request names, or undefined for "no model asked for".
 *
 * Shared by `resolveTerminalType` and `resolveAlternateSize` so the two cannot
 * disagree about what a string means -- the whole point of them being separate
 * functions over one table.
 */
function lookUpModel(opts: TerminalTypeOptions): Model | undefined {
  if (opts.model === undefined) return undefined;
  // Every x3270 form (`parseModel`): an optional IBM- in any case, 3279-N or 3278-N or a bare N,
  // an optional -E or -e. A regex over the folded name, so no lookup can reach Object.prototype.
  const p = parseModel(opts.model);
  if (p === undefined) {
    throw new TerminalTypeError(
      `unknown model ${JSON.stringify(opts.model)}; use 3279-N or 3278-N (N is 2 to 5), `
      + 'optionally with -E, or a bare N: e.g. 3279-2-E. '
      + 'Use --terminal-type to send an arbitrary string.',
    );
  }
  return { ttype: advertisedType(p, opts.mono === true), alternate: ALTERNATE[p.number] };
}

/**
 * The alternate screen size to build the session with.
 *
 * Undefined means "no model was named", which leaves the session at a model 2
 * where the alternate size equals the default. A raw `terminalType` string also
 * yields undefined ON PURPOSE: we cannot know what geometry an arbitrary string
 * implies, and guessing one from a substring would be worse than staying 24x80 --
 * the host is told what we claim by the string itself, and if the operator sends
 * `IBM-3278-4` that way they get the size they asked the host for but not a
 * buffer that can hold it. Use `-model` to get both.
 */
export function resolveAlternateSize(
  opts: TerminalTypeOptions,
): { readonly rows: number; readonly cols: number } | undefined {
  if (opts.terminalType !== undefined) return undefined;
  return lookUpModel(opts)?.alternate;
}

export interface TerminalTypeOptions {
  /** A model number, with or without the IBM- prefix. */
  model?: string;
  /** A complete ttype string, used verbatim. Wins over `model`. */
  terminalType?: string;
  /** x3270's `-mono`: every model is a mono 3278 (`model.c:155`). */
  mono?: boolean;
}

/**
 * The color mode, x3270's `mode3279` (`model.c:155`): the model's prefix (3279 or bare is color,
 * 3278 mono), forced off by `mono`. No model means the default, `3279-2-E`: color.
 */
export function isColorModel(opts: TerminalTypeOptions): boolean {
  if (opts.mono === true) return false;
  if (opts.model === undefined) return true;
  return parseModel(opts.model)?.color ?? true;
}

/**
 * The model with its color-mode prefix swapped: `3279` for color, `3278` for mono, keeping the
 * number and `-E`. What x3270's Options -> 3278/3279 items do to the model (`menubar.c:2310-2328`,
 * `toggle_m3279`). No model is the default (`TERMINAL_TYPE`); the result is always a canonical
 * `KNOWN_MODELS` key. A name `parseModel` refuses throws.
 */
export function withColorMode(model: string | undefined, color: boolean): string {
  const name = model ?? TERMINAL_TYPE.replace(/^IBM-/, '');
  const p = parseModel(name);
  if (p === undefined) throw new TerminalTypeError(`unknown model "${name}"`);
  return `327${color ? '9' : '8'}-${p.number}${p.extended ? '-E' : ''}`;
}

export function resolveTerminalType(opts: TerminalTypeOptions): string {
  if (opts.terminalType !== undefined) {
    if (opts.terminalType.length === 0) {
      throw new TerminalTypeError('terminal type must not be empty');
    }
    // Verbatim, and deliberately not case-folded: this is the escape hatch for
    // sending a host exactly the bytes the user asked for.
    return opts.terminalType;
  }

  // The default comes from TERMINAL_TYPE, not from KNOWN_MODELS['3278-2-E']. Both spell
  // IBM-3278-2-E today, but TERMINAL_TYPE is the single source of truth that telnet.ts
  // already defaults to (`opts.terminalType ?? TERMINAL_TYPE`), so the two default paths
  // cannot drift. KNOWN_MODELS is a convenience list of what a user may ask for by number;
  // editing it must never change what a session with no options negotiates.
  //
  // WHY -E IS THE DEFAULT, changed 2026-09-14. A bare IBM-3278-2 is REJECTED by MVS 3.8j
  // TSO with IKT00405I and no logon -- documented at the top of this file since stage 2a and
  // reproduced live through the GUI. Both live systems accept -E, so the flagless default is
  // the one that works on both. `-model 3278-2` still asks for the bare type.
  //
  // AN EARLIER COMMENT HERE CLAIMED THIS WAS LOAD-BEARING FOR THE VM/370 CONFORMANCE
  // COMPARISON. It is not, and the difference was measured rather than argued: flipping this
  // constant fails exactly four expectation tests, while conformance.test.ts and
  // golden.test.ts pass untouched. The offline comparison filters negotiation out of what it
  // diffs (conformance.test.ts, `isNegotiation`). The live script (conformance-vm.txt) has
  // TWO invocations that must be checked separately: the s3270 reference line was already
  // pinned to `-model 3278-2`, but our client's line originally passed no `-model` at all --
  // that gap was the one place the audit for this change first missed and then had to fix, by
  // adding `-model 3278-2` to our line too. Both invocations now name model 2 explicitly, so
  // neither depends on this constant.
  if (opts.model === undefined) return opts.mono === true ? 'IBM-3278-2-E' : TERMINAL_TYPE;
  return lookUpModel(opts)!.ttype;
}
