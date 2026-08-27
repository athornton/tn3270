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
 * which x3270 sends only for oversize (`telnet.c:2101`). Oversize itself is an
 * emulator extension rather than 3270 architecture -- no 3278 ever had a 160x62
 * screen -- and it is the one case that crosses 4096 cells into 14-bit
 * addressing. Both are deliberately out of scope here.
 *
 * Keys are uppercase because lookups are case-folded; see resolveTerminalType.
 */
export const KNOWN_MODELS: Readonly<Record<string, Model>> = {
  '3278-2': { ttype: 'IBM-3278-2', alternate: MODEL_2 },
  '3278-2-E': { ttype: 'IBM-3278-2-E', alternate: MODEL_2 },
  '3278-3': { ttype: 'IBM-3278-3', alternate: MODEL_3 },
  '3278-3-E': { ttype: 'IBM-3278-3-E', alternate: MODEL_3 },
  '3278-4': { ttype: 'IBM-3278-4', alternate: MODEL_4 },
  '3278-4-E': { ttype: 'IBM-3278-4-E', alternate: MODEL_4 },
  '3278-5': { ttype: 'IBM-3278-5', alternate: MODEL_5 },
  '3278-5-E': { ttype: 'IBM-3278-5-E', alternate: MODEL_5 },
};

/**
 * The model a request names, or undefined for "no model asked for".
 *
 * Shared by `resolveTerminalType` and `resolveAlternateSize` so the two cannot
 * disagree about what a string means -- the whole point of them being separate
 * functions over one table.
 */
function lookUpModel(opts: TerminalTypeOptions): Model | undefined {
  if (opts.model === undefined) return undefined;
  // Accept `3278-2-E`, `IBM-3278-2-E`, and any casing of either. x3270 matches
  // the prefix with strncasecmp("IBM-", res, 4) and the suffix with
  // strchr("Ee", res[7]) in Common/model.c canonical_model_x(), so a model
  // string s3270 accepts is accepted here too. Case folding cannot invent a
  // model: an unknown number still misses the table and throws.
  const folded = opts.model.toUpperCase();
  const bare = folded.startsWith('IBM-') ? folded.slice(4) : folded;
  // Own-property check, not a bare index: KNOWN_MODELS is a plain object, so
  // `KNOWN_MODELS['CONSTRUCTOR']`-style lookups would otherwise walk up to
  // Object.prototype and return a function that the `undefined` guard below
  // would wave through as if it were a model.
  const found = Object.hasOwn(KNOWN_MODELS, bare) ? KNOWN_MODELS[bare] : undefined;
  if (found === undefined) {
    throw new TerminalTypeError(
      `unknown model ${JSON.stringify(opts.model)}; known models are `
      + `${Object.keys(KNOWN_MODELS).join(', ')}. `
      + 'Use --terminal-type to send an arbitrary string.',
    );
  }
  return found;
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

  // The default comes from TERMINAL_TYPE, not from KNOWN_MODELS['3278-2'].
  // Both spell IBM-3278-2 today, but TERMINAL_TYPE is the single source of
  // truth that telnet.ts already defaults to (`opts.terminalType ??
  // TERMINAL_TYPE`), so the two default paths cannot drift. KNOWN_MODELS is a
  // convenience list of what a user may ask for by number; editing it must
  // never change what a session with no options negotiates.
  //
  // Keeping the default at IBM-3278-2 is what lets the VM/370 conformance
  // comparison stay valid: that run was recorded with our client negotiating
  // IBM-3278-2, so a live re-record after changing this would negotiate
  // something else. Note the committed .trace fixtures replay recorded bytes
  // and so do NOT themselves fail if this changes — verified by flipping
  // TERMINAL_TYPE and watching golden.test.ts and conformance.test.ts still
  // pass. The tests that do catch it are telnet.test.ts and termtype.test.ts.
  if (opts.model === undefined) return TERMINAL_TYPE;
  return lookUpModel(opts)!.ttype;
}
