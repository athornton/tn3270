/**
 * One `TN3270_GUI_KEYS` spelling to an Electron `sendInputEvent` chord.
 *
 * ## WHY THIS REFUSES INSTEAD OF TRANSLATING
 *
 * MEASURED on Electron 44.3.0, 2026-09-15 (`package.json` asks for `^44.0.0`; 44.3.0 is what
 * this tree resolves to and what every run here used): `sendInputEvent` accepts Accelerator names
 * (`1`, `Up`, `F1`, `]`), and a DOM CODE NAME is not rejected -- it is delivered as an
 * EMPTY event, `key: ''` and `keyCode: 0`. `actionForKey` then returns null, no action is
 * sent, and the harness still reports that it sent the key. A guard written with the wrong
 * spelling therefore passes while proving nothing.
 *
 * That spelling is the natural mistake here, because the GUI's own keymap is written in
 * terms of `e.code` and `e.key`: `Digit1` is exactly what the PA table matches on. So this
 * throws and names the valid form. It does NOT silently map `Digit1` to `1`, because that
 * would teach a spelling only our harness accepts.
 *
 * Modifier names are the ones a person writes; Electron wants lowercase `control`, `alt`,
 * `shift`, `meta`.
 */

/** Electron's modifier names, which are not the names anybody types. */
export type ChordModifier = 'control' | 'alt' | 'shift' | 'meta';

export interface KeySpec {
  /** Passed to `sendInputEvent` verbatim: an Electron Accelerator key name. */
  readonly keyCode: string;
  readonly modifiers: readonly ChordModifier[];
}

// A Map, not a plain object: a frozen plain object still inherits Object.prototype, so a
// bare index lookup on a segment like 'constructor' or '__proto__' returns a function or
// object instead of undefined -- truthy, not a ChordModifier, and invisible to tsc.
const MODIFIER_ALIASES: ReadonlyMap<string, ChordModifier> = new Map([
  ['ctrl', 'control'], ['control', 'control'],
  ['alt', 'alt'], ['option', 'alt'],
  ['shift', 'shift'],
  ['meta', 'meta'], ['cmd', 'meta'], ['command', 'meta'], ['super', 'meta'],
]);

/** The families of DOM code names, all of which arrive empty. */
const DOM_CODE = /^(Digit|Key|Numpad|Arrow)/;

/** The valid spelling for the DOM names somebody is most likely to write. */
function validSpelling(key: string): string | undefined {
  const arrow = /^Arrow(Up|Down|Left|Right)$/.exec(key);
  if (arrow !== null) return arrow[1];
  const digit = /^Digit(\d)$/.exec(key);
  if (digit !== null) return digit[1];
  const letter = /^Key([A-Za-z])$/.exec(key);
  if (letter !== null) return letter[1]!.toLowerCase();
  return undefined;
}

export function parseKeySpec(spec: string): KeySpec {
  const trimmed = spec.trim();
  if (trimmed === '') throw new Error('empty key spec');

  const segments = trimmed.split('+');
  const modifiers: ChordModifier[] = [];
  let i = 0;
  // Consumed GREEDILY FROM THE FRONT, with the remainder rejoined as the key, so that '+'
  // and 'Ctrl++' still name a literal plus. A `pop()` would turn both into an empty key,
  // and an empty key is an empty event.
  while (i < segments.length - 1) {
    const alias = MODIFIER_ALIASES.get(segments[i]!.toLowerCase());
    if (alias === undefined) break;
    if (!modifiers.includes(alias)) modifiers.push(alias);
    i += 1;
  }

  const rest = segments.slice(i);
  const key = rest.join('+');
  if (key === '') {
    throw new Error(`key spec '${spec}' names modifiers but no key`);
  }
  // More than one leftover segment is only legitimate when the key IS a plus, which arrives
  // as empty segments. Anything else -- 'Ctl+1' -- is a misspelled modifier, and passing it
  // through verbatim is how it would reach Chromium as an empty event.
  if (rest.length > 1 && !rest.every((s) => s === '')) {
    throw new Error(
      `unknown modifier in key spec '${spec}': use Ctrl, Alt, Shift or Meta`,
    );
  }

  if (DOM_CODE.test(key)) {
    const valid = validSpelling(key);
    throw new Error(
      `key spec '${spec}' uses the DOM code name '${key}', which sendInputEvent delivers ` +
      `as an empty event rather than refusing` +
      (valid !== undefined ? `; use '${valid}'` : ''),
    );
  }

  return { keyCode: key, modifiers };
}
