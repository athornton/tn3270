import { TERMINAL_TYPE } from './constants.js';

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

/**
 * Model number to ttype string.
 *
 * Deliberately tiny: only models we can honestly claim while the screen is
 * pinned at 24x80. A model implying another geometry needs alternate-size
 * support first, which stage 2a does not implement. Sizes per x3270
 * include/3270ds.h: model 2 is 24x80 (MODEL_2_ROWS 24, MODEL_2_COLS 80),
 * model 3 is 32x80, model 4 is 43x80, model 5 is 27x132.
 *
 * Keys are uppercase because lookups are case-folded; see resolveTerminalType.
 */
export const KNOWN_MODELS: Readonly<Record<string, string>> = {
  '3278-2': 'IBM-3278-2',
  '3278-2-E': 'IBM-3278-2-E',
};

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
  // would wave through as if it were a ttype string.
  const resolved = Object.hasOwn(KNOWN_MODELS, bare) ? KNOWN_MODELS[bare] : undefined;
  if (resolved === undefined) {
    throw new TerminalTypeError(
      `unknown model ${JSON.stringify(opts.model)}; known models are `
      + `${Object.keys(KNOWN_MODELS).join(', ')}. `
      + 'Use --terminal-type to send an arbitrary string.',
    );
  }
  return resolved;
}
