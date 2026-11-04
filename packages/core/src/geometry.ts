import { MODEL_2 } from './constants.js';
import { resolveTerminalType, resolveAlternateSize, type TerminalTypeOptions } from './termtype.js';

/**
 * Oversize: an alternate screen larger than the model's, and the geometry a session negotiates.
 *
 * An emulator extension, not 3270 architecture -- see the spec,
 * docs/superpowers/specs/2026-11-04-oversize-and-model-switching-design.md. The rules are
 * x3270's: `ctlr.c:check_rows_cols` (`:321-335`) for the limits, `telnet.c:2100`
 * (`create_3270_termtype`) for IBM-DYNAMIC.
 *
 * PURE. The measure function is the caller's; nothing here touches a window or a session.
 * Nothing calls this module yet -- `Session` is wired to it in a later task.
 */

/** x3270's MAX_ROWS_COLS (include/3270ds.h:456): the cells a 14-bit address reaches. */
export const MAX_OVERSIZE_CELLS = 0x3fff;

export type Oversize =
  | { readonly kind: 'none' }
  | { readonly kind: 'fixed'; readonly rows: number; readonly cols: number }
  | { readonly kind: 'auto' };

export interface Size { readonly rows: number; readonly cols: number }

/** What the operator asked for. `measure` is the front end's, consulted only for `auto`. */
export interface GeometrySetting extends TerminalTypeOptions {
  readonly oversize: Oversize;
  /** Cells the front end can show right now, or undefined if it cannot tell yet. */
  readonly measure?: () => Size | undefined;
}

export interface ResolvedGeometry {
  readonly terminalType: string;
  readonly default: Size;
  readonly alternate: Size;
  /** True when an oversize is in effect, i.e. the terminal type is IBM-DYNAMIC. */
  readonly oversize: boolean;
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
  if (m === null) throw new OversizeError(`-oversize ${JSON.stringify(text)}: ${FORM}`);
  const cols = Number(m[1]);
  const rows = Number(m[2]);
  // The regexp already excludes a leading '-' and a decimal point, so the only way either
  // number reaches here as zero is a literal "0" -- '0x24' or '80x0'. Reject it as the same
  // malformed-argument case rather than letting it through to the floor/ceiling checks below,
  // where a zero-size oversize would either divide-by-zero (auto's clamp) or merely look like
  // an oddly-worded "smaller than the model" refusal instead of what it is: not a size.
  if (cols === 0 || rows === 0) throw new OversizeError(`-oversize ${JSON.stringify(text)}: ${FORM}`);
  return { kind: 'fixed', rows, cols };
}

export function resolveGeometry(setting: GeometrySetting): ResolvedGeometry {
  // resolveTerminalType/resolveAlternateSize take only {model, terminalType}; GeometrySetting
  // extends that with `oversize` and `measure`, which they must never see, so TypeScript's
  // excess-property check (which only fires on an object LITERAL, not a variable) would wave
  // the whole `setting` straight through. Picking the two fields out explicitly is what makes
  // extending TerminalTypeOptions safe here. exactOptionalPropertyTypes also requires this: a
  // `model: undefined` key is not the same as an absent one, so each is included only when
  // present.
  const typeOpts: TerminalTypeOptions = {
    ...(setting.model !== undefined ? { model: setting.model } : {}),
    ...(setting.terminalType !== undefined ? { terminalType: setting.terminalType } : {}),
  };
  // Both calls throw the same TerminalTypeError for an unknown model; let it propagate rather
  // than catching it, so a typo in --model fails exactly as it does without -oversize.
  const modelTtype = resolveTerminalType(typeOpts);
  // resolveAlternateSize returns undefined for "no model named" (session stays a model 2, 24x80)
  // and for a raw --terminal-type (deliberately: we cannot know what geometry an arbitrary
  // string implies). Model 2's own alternate IS 24x80, so the fallback below is exactly right
  // for both cases, not a stand-in for one of them.
  const modelAlt = resolveAlternateSize(typeOpts) ?? MODEL_2;
  const def: Size = { rows: MODEL_2.rows, cols: MODEL_2.cols };
  const plain: ResolvedGeometry = { terminalType: modelTtype, default: def, alternate: modelAlt, oversize: false };
  // For messages only: the model NUMBER if one was given (what the operator typed), else the
  // ttype with its IBM- prefix stripped, so "model 3278-2-E" reads the same whichever path
  // produced it.
  const modelName = setting.model ?? modelTtype.replace(/^IBM-/, '');

  const o = setting.oversize;
  if (o.kind === 'none') return plain;
  if (setting.terminalType !== undefined) {
    throw new OversizeError('-oversize and --terminal-type cannot both be given: an oversize '
      + 'is advertised as IBM-DYNAMIC');
  }

  if (o.kind === 'fixed') {
    const asked = `${o.cols}x${o.rows}`;
    const cells = o.rows * o.cols;
    if (cells > MAX_OVERSIZE_CELLS) {
      throw new OversizeError(`oversize ${asked} refused: ${cells} cells is more than `
        + `the ${MAX_OVERSIZE_CELLS} a 14-bit address reaches`);
    }
    if (o.rows < modelAlt.rows || o.cols < modelAlt.cols) {
      throw new OversizeError(`oversize ${asked} refused: use at least ${modelAlt.cols}x${modelAlt.rows} `
        + `-- model ${modelName} is ${describeSize(modelAlt)}`);
    }
    return { terminalType: 'IBM-DYNAMIC', default: def, alternate: { rows: o.rows, cols: o.cols }, oversize: true };
  }

  // o.kind === 'auto'
  if (setting.measure === undefined) {
    throw new OversizeError('oversize auto needs a window to measure; give -oversize <cols>x<rows> instead');
  }
  const fits = setting.measure();
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
      terminalType: 'IBM-DYNAMIC', default: def, alternate: { rows, cols: fits.cols }, oversize: true,
      clamp: `oversize auto: window fits ${describeSize(fits)}; cut to ${rows} rows, the 14-bit address limit`,
    };
  }
  return { terminalType: 'IBM-DYNAMIC', default: def, alternate: fits, oversize: true };
}
