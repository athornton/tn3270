import {
  OversizeError, resolveTerminalType, resolveAlternateSize,
  type GeometrySetting, type Oversize,
} from '@tn3270/core';

/**
 * ONE model-or-oversize choice from a list, and the rule for applying it. Shared by every front
 * end that offers the choices as a list -- the GUI's Model menu and the web gateway's `Alt-M`
 * overlay -- so the two cannot drift on what a click does. Moved here from `gui/src/menu.ts`.
 */

/** What one list item asks for: ONE field, because one click changes one thing. */
export type GeometryChoice = { readonly model: string } | { readonly oversize: Oversize };

/** The model as the host will see it: core's resolution, `IBM-` stripped. */
function modelName(model: string): string {
  return resolveTerminalType({ model }).replace(/^IBM-/, '');
}

/**
 * Why `current.oversize` cannot go with `model`, as a notice for the operator, or `undefined` if
 * that is not the reason. Decided from the SETTING, not by parsing core's message.
 *
 * NEITHER TEXT QUOTES CORE'S REMEDY, which is written for a command line: `use -model 3278-4-E`
 * names a flag, and `use at least 132x27` names a size, and a list offers neither. Each says what
 * happened first (the status line truncates), then a choice the list DOES offer.
 */
function explainReset(current: Oversize, model: string): string | undefined {
  const name = modelName(model);
  if (!name.endsWith('-E')) {
    return `oversize is now None: model ${name} has no extended data stream; `
      + `pick ${name}-E for an oversize`;
  }
  const alt = resolveAlternateSize({ model });
  if (current.kind === 'fixed' && alt !== undefined
    && (current.rows < alt.rows || current.cols < alt.cols)) {
    return `oversize is now None: ${current.cols}x${current.rows} is smaller than model ${name}; `
      + 'pick Auto, or a model it fits';
  }
  return undefined;
}

/**
 * Apply one choice through `setGeometry`, and THE ORDER-DEPENDENCE RULE.
 *
 * A list changes one thing per click, and core validates model and oversize TOGETHER -- the
 * CLI's `Set()` found that some single steps are refused (commit `1a4713e`): from a fixed 100x30,
 * model 3278-5-E alone is refused. The CLI's answer, both in one call, is not available to a
 * radio item. So: A MODEL CHOICE WINS. If the CURRENT oversize is what refuses it -- the model has
 * no extended data stream, or a fixed size is below the model -- the model is applied with
 * oversize None and the returned notice says so.
 *
 * WHY THE MODEL WINS AND NOT THE OVERSIZE: refusing would leave models unreachable from a list
 * whose only fixed size is the startup one. None always fits a known model, so every model stays
 * reachable, and the startup size comes back by picking a model it fits and then the size.
 *
 * AN OVERSIZE CHOICE IS NEVER FIXED UP by changing the model behind it: that would change the
 * thing the operator did not touch. Its refusal, and every refusal that is not explained above
 * (`disconnect first`, `wait for the connection attempt`, an unknown model), is thrown unchanged.
 * If the retry with None is refused too, that second refusal is the one thrown.
 *
 * `setGeometry` is a parameter so this is testable with no session.
 */
export function applyGeometryChoice(
  current: GeometrySetting, choice: GeometryChoice, setGeometry: (next: GeometrySetting) => void,
): string | undefined {
  if (!('model' in choice)) {
    setGeometry({ ...current, oversize: choice.oversize });
    return undefined;
  }
  const next: GeometrySetting = { ...current, model: choice.model };
  try {
    setGeometry(next);
    return undefined;
  } catch (err) {
    if (!(err instanceof OversizeError) || current.oversize.kind === 'none') throw err;
    const notice = explainReset(current.oversize, choice.model);
    if (notice === undefined) throw err;
    setGeometry({ ...next, oversize: { kind: 'none' } });
    return notice;
  }
}
