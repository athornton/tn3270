import { MODEL_2 } from './constants.js';
import { resolveTerminalType, resolveAlternateSize, type TerminalTypeOptions } from './termtype.js';

/**
 * Oversize: an alternate screen larger than the model's, and the geometry a session negotiates.
 *
 * An emulator extension, not 3270 architecture -- see the spec,
 * docs/superpowers/specs/2026-11-04-oversize-and-model-switching-design.md. The rules are
 * x3270's: `ctlr.c:check_rows_cols` (`:321-335`) for the limits, `telnet.c:2100`
 * (`create_3270_termtype`) for IBM-DYNAMIC, `model.c:204-205`/`:333-335` for the extended-data-
 * stream requirement below.
 *
 * PURE. The measure function is a parameter, not part of the setting -- see the note on
 * `resolveGeometry`'s signature.
 */

/** x3270's MAX_ROWS_COLS (include/3270ds.h:456): the cells a 14-bit address reaches. */
export const MAX_OVERSIZE_CELLS = 0x3fff;

export type Oversize =
  | { readonly kind: 'none' }
  | { readonly kind: 'fixed'; readonly rows: number; readonly cols: number }
  | { readonly kind: 'auto' };

export interface Size { readonly rows: number; readonly cols: number }

/**
 * What the operator asked for. Plain data, deliberately: Task 2's `Session.setGeometry` and the
 * web gateway's `setGeometry` message both REPLACE this object wholesale, and a function
 * attached to it would be silently dropped by that replacement. The measure function is instead
 * a second, separate argument to `resolveGeometry`, supplied fresh by the caller every time.
 */
export interface GeometrySetting extends TerminalTypeOptions {
  readonly oversize: Oversize;
}

export interface ResolvedGeometry {
  readonly terminalType: string;
  readonly default: Size;
  readonly alternate: Size;
  /** True when the terminal type is IBM-DYNAMIC, i.e. an oversize is in effect. */
  readonly dynamic: boolean;
  /** For the operator: an `auto` that fell back to the model. */
  readonly notice?: string;
  /** For the trace only: an `auto` cut to the 14-bit limit. */
  readonly clamp?: string;
}

export class OversizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OversizeError';
  }
}

export function describeSize(s: Size): string {
  return `${s.rows} rows by ${s.cols} columns`;
}

const FORM = '<cols>x<rows>, auto or none';

/** Echoes a bad argument in an error message without letting it push the remedy off a line. */
function truncate(text: string): string {
  return text.length > 20 ? `${text.slice(0, 20)}...` : text;
}

/**
 * Parses the `-oversize` flag's argument. x3270's own order, `model.c:343`: `<cols>x<rows>`,
 * so `160x62` is 62 rows by 160 columns -- see the spec's note on why this project's new
 * messages still say the size in words rather than repeat that ordering.
 */
export function parseOversize(text: string): Oversize {
  const t = text.trim().toLowerCase();
  if (t === 'none') return { kind: 'none' };
  if (t === 'auto') return { kind: 'auto' };
  const m = /^([0-9]+)x([0-9]+)$/.exec(t);
  if (m === null) throw new OversizeError(`-oversize takes ${FORM}, not ${JSON.stringify(truncate(text))}`);
  const cols = Number(m[1]);
  const rows = Number(m[2]);
  // `Number.isSafeInteger` rather than just checking for NaN: the regexp accepts an arbitrarily
  // long run of digits, and `Number(...)` on one past 2^53 either loses precision silently or,
  // past about 309 digits, overflows to Infinity. Both must be refused here, with the ordinary
  // parse message -- not let an Infinity or an imprecise value reach the cell-count arithmetic
  // below as e.g. `Infinityx24`.
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows)) {
    throw new OversizeError(`-oversize takes ${FORM}, not ${JSON.stringify(truncate(text))}`);
  }
  // Zero is not a size. x3270 refuses it the same way it refuses a non-numeric argument --
  // `ctlr.c:258-263`, "Invalid oversize ... columns: zero" / "... rows: zero", both before the
  // model-floor and cell-limit checks -- so this is the malformed-argument case, not a
  // too-small oversize.
  if (cols === 0 || rows === 0) throw new OversizeError(`-oversize takes ${FORM}, not ${JSON.stringify(truncate(text))}`);
  return { kind: 'fixed', rows, cols };
}

/** A positive integer, or an `OversizeError` naming which field and what it actually was. */
function positiveInt(value: number, field: 'rows' | 'cols'): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new OversizeError(`oversize needs a positive whole number of ${field}, not ${value}`);
  }
  return value;
}

/**
 * Resolves a model plus an oversize setting into a terminal type and the two sizes a session
 * negotiates with.
 *
 * `measure` is NOT a field of `setting` -- see the comment on `GeometrySetting`. It is called at
 * most once, and only for `oversize: { kind: 'auto' }`; `none` and `fixed` never touch it.
 */
export function resolveGeometry(
  setting: GeometrySetting,
  measure?: () => Size | undefined,
): ResolvedGeometry {
  // `setting` satisfies TerminalTypeOptions structurally (it extends it), and passing a
  // variable -- as opposed to an object LITERAL -- does not trigger TypeScript's excess-
  // property check, so the extra `oversize` field is not a problem here.
  const modelTtype = resolveTerminalType(setting);
  // resolveAlternateSize returns undefined for "no model named" (session stays a model 2, 24x80)
  // and for a raw --terminal-type (deliberately: we cannot know what geometry an arbitrary
  // string implies). Model 2's own alternate IS 24x80, so the fallback below is exactly right
  // for both cases, not a stand-in for one of them.
  const modelAlt = resolveAlternateSize(setting) ?? MODEL_2;
  const def: Size = { rows: MODEL_2.rows, cols: MODEL_2.cols };
  const plain: ResolvedGeometry = { terminalType: modelTtype, default: def, alternate: modelAlt, dynamic: false };
  // For messages: the model as the host will see it, i.e. the resolved terminal type with its
  // IBM- prefix stripped -- not `setting.model` as the operator typed it, so `-model
  // ibm-3278-4-e` is reported as `model 3278-4-E` and not in whatever case or spelling it was
  // given in.
  const modelName = modelTtype.replace(/^IBM-/, '');

  const o = setting.oversize;
  if (o.kind === 'none') return plain;
  if (setting.terminalType !== undefined) {
    throw new OversizeError('-oversize and --terminal-type cannot both be given: an oversize '
      + 'is advertised as IBM-DYNAMIC');
  }
  // x3270 drops oversize to nothing when extended_data_stream is off, silently
  // (`oversize_init`, `model.c:204-205` and `:333-335`, "Without extended, no oversize"). That
  // would connect a session with a geometry the operator never asked for, so refuse instead of
  // following x3270 here. The product default with no `-model` is `IBM-3278-2-E`, which already
  // claims it, so this only bites an explicit non-`-E` `-model`.
  if (!modelTtype.endsWith('-E')) {
    throw new OversizeError(`oversize needs an extended model: use -model ${modelName}-E -- `
      + `model ${modelName} does not claim the extended data stream that Query Reply needs`);
  }

  if (o.kind === 'fixed') {
    const rows = positiveInt(o.rows, 'rows');
    const cols = positiveInt(o.cols, 'cols');
    const asked = `${cols}x${rows}`;
    const cells = rows * cols;
    if (cells > MAX_OVERSIZE_CELLS) {
      throw new OversizeError(`oversize ${asked} refused: use at most ${MAX_OVERSIZE_CELLS} cells `
        + `-- that is ${cells}`);
    }
    if (rows < modelAlt.rows || cols < modelAlt.cols) {
      throw new OversizeError(`oversize ${asked} refused: use at least ${modelAlt.cols}x${modelAlt.rows} `
        + `-- model ${modelName} is ${describeSize(modelAlt)}`);
    }
    return { terminalType: 'IBM-DYNAMIC', default: def, alternate: { rows, cols }, dynamic: true };
  }

  // o.kind === 'auto'
  if (measure === undefined) {
    throw new OversizeError('oversize auto needs a window to measure; give -oversize <cols>x<rows> instead');
  }
  const measured = measure();
  // A window the front end cannot vouch for -- unmeasured, or measured to something that is
  // not actually a usable size (NaN, a fraction, zero, negative) -- gets the same fallback as
  // "no window size known": there is no fit to check, honest or otherwise.
  const fits: Size | undefined = (measured !== undefined
    && Number.isInteger(measured.rows) && measured.rows > 0
    && Number.isInteger(measured.cols) && measured.cols > 0)
    ? { rows: measured.rows, cols: measured.cols } // copied, not the caller's object
    : undefined;
  if (fits === undefined) {
    return { ...plain, notice: 'oversize auto: no window size known; using the model' };
  }
  if (fits.rows < modelAlt.rows || fits.cols < modelAlt.cols) {
    return {
      ...plain,
      notice: `oversize auto: window fits ${describeSize(fits)}, less than model `
        + `${modelName}'s ${describeSize(modelAlt)}; using the model`,
    };
  }
  if (fits.rows * fits.cols > MAX_OVERSIZE_CELLS) {
    const rows = Math.floor(MAX_OVERSIZE_CELLS / fits.cols);
    // A very wide window can clamp BELOW the model's rows (past 682 columns for a model 2;
    // sooner for a taller model's floor). That is the same outcome as a window too small: the
    // model is the floor, so fall back to it rather than hand back fewer rows than the model
    // guarantees.
    if (rows < modelAlt.rows) {
      return {
        ...plain,
        notice: `oversize auto: window fits ${describeSize(fits)}, too wide to keep model `
          + `${modelName}'s ${modelAlt.rows} rows inside ${MAX_OVERSIZE_CELLS} cells; using the model`,
      };
    }
    return {
      terminalType: 'IBM-DYNAMIC', default: def, alternate: { rows, cols: fits.cols }, dynamic: true,
      clamp: `oversize auto: window fits ${describeSize(fits)}; cut to ${rows} rows, the 14-bit address limit`,
    };
  }
  return { terminalType: 'IBM-DYNAMIC', default: def, alternate: fits, dynamic: true };
}
