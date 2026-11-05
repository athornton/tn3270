import {
  KNOWN_MODELS, describeSize, resolveTerminalType, type Session, type Size,
} from '@tn3270/core';
import { applyGeometryChoice, type GeometryChoice } from '@tn3270/frontend';
import type { GeometryChoices, OversizeName } from './geometryOverlay.js';

/**
 * The gateway half of the `Alt-M` picker: what to offer, and what a pick does. 2026-11-04.
 *
 * THE GUI's MODEL MENU IS THE REFERENCE (`gui/src/menu.ts`'s `modelMenu` and `modelMenuStates`),
 * and every rule here is that one: the eight models in `KNOWN_MODELS` order, each labelled with
 * its size in words; oversize None, Auto and the startup fixed size if there was one; the checked
 * model from core's own `resolveTerminalType`; disabled while connected OR connecting. Gateway-side
 * because the browser module that draws them is served unbundled and cannot import core.
 */

/**
 * The choices for one session, or `undefined` for a session with no geometry setting -- a legacy
 * `--terminal-type` session, which the gateway CANNOT build (it takes no `--terminal-type`, and
 * `buildSession` always passes a setting). Guarded anyway, as the GUI guards it: a picker of eight
 * models that all refuse would be eight controls that cannot work.
 */
export function geometryChoices(
  session: Session, startupFixed: Size | undefined, notice?: string,
): GeometryChoices | undefined {
  const current = session.geometrySetting;
  if (current === undefined) return undefined;
  let model = '';
  try {
    // Core's own resolution, so an absent model is the product default, exactly what a connect
    // would advertise. A refusal checks nothing rather than guessing -- the GUI's rule.
    model = resolveTerminalType(current.model !== undefined ? { model: current.model } : {})
      .replace(/^IBM-/, '');
  } catch { /* checks nothing */ }
  const o = current.oversize;
  const oversize: OversizeName | null = o.kind === 'none' ? 'none'
    : o.kind === 'auto' ? 'auto'
      // A fixed size is checked as `startup` only when it IS the startup one. Any other is
      // unreachable from the web (see `protocol.ts`'s `geometryChoices`), and checks nothing.
      : startupFixed !== undefined && o.rows === startupFixed.rows && o.cols === startupFixed.cols
        ? 'startup' : null;
  return {
    models: Object.keys(KNOWN_MODELS).map((m) => {
      const alt = KNOWN_MODELS[m]?.alternate;
      return { name: m, label: alt !== undefined ? `${m} (${describeSize(alt)})` : m };
    }),
    oversizes: [
      { name: 'none', label: 'None' },
      { name: 'auto', label: 'Auto' },
      // `<cols>x<rows>` as typed on `-oversize` (x3270's order), then the size in words.
      ...(startupFixed !== undefined
        ? [{ name: 'startup' as const,
          label: `${startupFixed.cols}x${startupFixed.rows} (${describeSize(startupFixed)})` }]
        : []),
    ],
    current: { model, oversize },
    connected: session.isConnected() || session.isConnecting(),
    ...(notice !== undefined ? { notice } : {}),
  };
}

/** What `applyPick` did: a notice for the operator if there is one, and whether it was refused. */
export type PickOutcome =
  | { readonly refused: false; readonly notice?: string }
  | { readonly refused: true; readonly notice: string };

/** The refusal for `startup` on a gateway that was given no fixed size. Remedy first. */
export const NO_STARTUP_SIZE =
  'no startup size to return to; this gateway was started without -oversize <cols>x<rows>';

/**
 * Apply ONE pick to `session`, through `applyGeometryChoice` -- the GUI's rule, unchanged.
 *
 * NEVER THROWS, because the caller is the gateway's socket handler, where a throw ends the
 * process and every other operator's session (`protocol.ts`'s two-branch rule). Every refusal --
 * `disconnect first`, `wait for the connection attempt`, `auto` on a non-`-E` model, a `startup`
 * this gateway does not have -- comes back as a notice instead.
 */
export function applyPick(
  session: Session, startupFixed: Size | undefined,
  pick: { readonly model: string } | { readonly oversize: OversizeName },
): PickOutcome {
  const current = session.geometrySetting;
  if (current === undefined) {
    return { refused: true, notice: 'this session has no model to choose: its terminal type is fixed' };
  }
  let choice: GeometryChoice;
  if ('model' in pick) {
    choice = { model: pick.model };
  } else if (pick.oversize === 'startup') {
    if (startupFixed === undefined) return { refused: true, notice: NO_STARTUP_SIZE };
    choice = { oversize: { kind: 'fixed', rows: startupFixed.rows, cols: startupFixed.cols } };
  } else {
    choice = { oversize: { kind: pick.oversize } };
  }
  try {
    const notice = applyGeometryChoice(current, choice, (next) => { session.setGeometry(next); });
    return notice !== undefined ? { refused: false, notice } : { refused: false };
  } catch (err) {
    return { refused: true, notice: err instanceof Error ? err.message : String(err) };
  }
}
