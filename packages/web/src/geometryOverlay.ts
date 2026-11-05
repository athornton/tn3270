/**
 * The web gateway's MODEL/OVERSIZE PICKER, `Alt-M`: an opaque panel of radio buttons in the same
 * pane, the browser's counterpart of the GUI's Model menu. 2026-11-04.
 *
 * ## THE CHOICES COME FROM THE GATEWAY, AND THIS FILE SPELLS NONE OF THEM
 *
 * The gateway owns the session, so it sends `geometryChoices` (`protocol.ts`) on `hello`, on every
 * connect and disconnect, and after every `setGeometry`: the models IN `KNOWN_MODELS` ORDER and the
 * oversize names, each WITH ITS LABEL, plus what is current and whether the session is connected.
 * Labels travel because this module is served to the browser unbundled: it cannot import
 * `@tn3270/core` for `KNOWN_MODELS` or `describeSize`, and a copy of either here would drift from
 * the one a connect reads. `web/src/geometryChoices.ts` builds them the GUI's way.
 *
 * ## THE FOUR RULES OF `keyboardOverlay.ts`, FOR THE REASONS THAT FILE AND `keypadOverlay.ts` GIVE
 *
 *  - HIDDEN AT THE START, in code as well as in the markup's `hidden`: either alone is removable
 *    by someone who sees the other, and a REATTACHING tab must not inherit a display state.
 *  - BUILT LAZILY AND EXACTLY ONCE -- on the first moment it is both SHOWN and has choices, since
 *    the radios are made from them. Rebuilding per update would discard focus; `update` only
 *    writes `checked` and `disabled` onto the radios already there.
 *  - `hide()` ASSIGNS, so a second close cannot re-show.
 *  - OPAQUE, `background: Canvas` in `ui.css`, so the 3270 screen does not show through the labels.
 *
 * ## DISABLED WHILE CONNECTED OR CONNECTING, AND IT SAYS SO
 *
 * `Session.setGeometry` refuses both (the terminal type is already on the wire, or an attempt in
 * flight has already resolved what it will advertise), so every radio is disabled and the status
 * line reads `CONNECTED_LINE`. A disabled radio is neither clickable nor focusable, and `pick`
 * checks `connected` again besides, so nothing is sent.
 *
 * ## A PICK IS A POINTER CLICK, OR ENTER/SPACE -- NEVER `change`, 2026-11-05
 *
 * Listening on `change` was the first version, and review found it APPLIED EVERY RADIO AN ARROW KEY
 * PASSED: arrows in a radio group move the check, firing `change` and a click on each one -- and a
 * model passed on the way can reset the oversize to None. So arrowing is free movement, and a pick
 * is a click with `detail >= 1` (a real pointer; the clicks arrows and Space synthesise carry
 * `detail` 0) or Enter/Space on the focused radio, handled on `keydown` -- which also covers
 * Space, whose own synthetic click is then ignored, so it sends once.
 *
 * ## ESCAPE AND Alt+M CLOSE IT FROM INSIDE, 2026-11-05
 *
 * `renderer.ts` ignores every keydown aimed at an INPUT (the fix that keeps typed letters out of
 * the host), so with a radio focused the page's own Alt+M never ran and only the Close button
 * worked. The overlay listens itself, matching Alt+M as `keys.ts` does -- `e.code === 'KeyM'` with
 * Alt and no Ctrl or Meta, so Option-M's `µ` counts -- and stops the event there, so the window
 * listener cannot toggle it straight back open when the focus is not on an input.
 *
 * ## A CHOICE IS ONE FIELD
 *
 * `{kind:'setGeometry', model}` or `{kind:'setGeometry', oversize}`, never both: one click changes
 * one thing, and the gateway applies it through `applyGeometryChoice` -- the GUI's own rule. The
 * browser checks a clicked radio ITSELF, before the gateway has answered; the reply's `update` is
 * what puts the check back where the session really is when a choice was refused or reset.
 *
 * DOM INJECTED, like `keypadUi.ts`, so this runs under vitest's `environment: 'node'` with fakes.
 * NO IMPORTS AT ALL, so `httpstatic.ts` serves it flat and the import map needs no entry.
 */

/** An oversize choice by NAME. `startup` is the gateway's `-oversize <cols>x<rows>`, if it had one. */
export type OversizeName = 'none' | 'auto' | 'startup';

/** One radio: the value sent back, and the text beside it. */
export interface Choice<N extends string = string> { readonly name: N; readonly label: string }

/**
 * What the gateway sends. `protocol.ts`'s `ServerMessage` uses this type, so the two halves cannot
 * disagree on the shape.
 *
 * `current.oversize` IS `null` when the session's oversize is none of the offered choices: a fixed
 * size other than the startup one. UNREACHABLE FROM THE WEB -- the only fixed size any client can
 * set is the startup one, and the setting starts as it -- so it checks nothing rather than lying,
 * the GUI's rule for a model it cannot resolve.
 *
 * `notice` rides ONLY on the reply to a `setGeometry`: what happened, action first -- a model that
 * reset the oversize to None, or the refusal. Shown in the picker, where the operator clicked.
 */
export interface GeometryChoices {
  readonly models: readonly Choice[];
  readonly oversizes: readonly Choice<OversizeName>[];
  readonly current: { readonly model: string; readonly oversize: OversizeName | null };
  /** Connected OR connecting: every choice is disabled while true. */
  readonly connected: boolean;
  /**
   * CONNECTING, NOT YET CONNECTED -- `Session.isConnecting()`. `connected` alone cannot tell the
   * two apart, since it is `isConnected() || isConnecting()` (`geometryChoices.ts`), and the two
   * states have DIFFERENT remedies in core: `Session.setGeometry` throws `disconnect first` once
   * `conn` is live, and `wait for the connection attempt to finish` while only `reconnecting` or
   * `connecting` is (session.ts ~:502-510, pinned by core/test/oversize-session.test.ts ~:314 and
   * its first-connect sibling). `CONNECTED_LINE` gave the `disconnect first` remedy in BOTH cases
   * until review found it: an operator watching a connect attempt was told to disconnect something
   * that does not exist yet. This field is what lets the picker tell them apart.
   */
  readonly connecting: boolean;
  readonly notice?: string;
}

/** The status line while every choice is disabled AND the session is actually connected. */
export const CONNECTED_LINE = 'Disconnect first; the choice applies at the next connect.';
/**
 * The status line while every choice is disabled but the session is only CONNECTING -- see
 * `GeometryChoices.connecting`. There is nothing to disconnect yet; the attempt itself has to
 * finish (or fail) before a choice can be made, exactly as `Session.setGeometry` says.
 */
export const CONNECTING_LINE = 'Wait for the connection attempt to finish; '
  + 'the choice applies at the next connect.';

const OVERSIZE_NAMES: readonly string[] = ['none', 'auto', 'startup'];

/**
 * Narrow a parsed `geometryChoices` message, THROWING on anything malformed.
 *
 * `bridgecore.ts` deliberately validates nothing it receives and hands this kind over loosely
 * typed, as it does the transfer kinds; this is the narrowing that file says belongs to the
 * consumer. A throw lands in the bridge's message chain's `catch`, which PAINTS it -- a malformed
 * reply is a gateway bug and should be seen, not drop the picker into a half-drawn state.
 */
export function parseGeometryChoices(msg: Record<string, unknown>): GeometryChoices {
  const fail = (what: string): never => { throw new Error(`geometryChoices ${what}`); };
  const list = (v: unknown, what: string, names?: readonly string[]): Choice[] => {
    if (!Array.isArray(v)) return fail(`${what} must be an array`);
    return v.map((c: unknown) => {
      const o = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
      const { name, label } = o;
      if (typeof name !== 'string' || typeof label !== 'string') {
        return fail(`${what} must each have a string name and label`);
      }
      if (names !== undefined && !names.includes(name)) return fail(`${what} has an unknown name`);
      return { name, label };
    });
  };
  const models = list(msg['models'], 'models');
  const oversizes = list(msg['oversizes'], 'oversizes', OVERSIZE_NAMES) as Choice<OversizeName>[];
  const cur = msg['current'];
  const c = (typeof cur === 'object' && cur !== null ? cur : {}) as Record<string, unknown>;
  if (typeof c['model'] !== 'string') fail('current.model must be a string');
  const o = c['oversize'];
  if (o !== null && (typeof o !== 'string' || !OVERSIZE_NAMES.includes(o))) {
    fail('current.oversize must be none, auto, startup or null');
  }
  if (typeof msg['connected'] !== 'boolean') fail('connected must be a boolean');
  if (typeof msg['connecting'] !== 'boolean') fail('connecting must be a boolean');
  const notice = msg['notice'];
  if (notice !== undefined && typeof notice !== 'string') fail('notice must be a string');
  return {
    models, oversizes,
    current: { model: c['model'] as string, oversize: o as OversizeName | null },
    connected: msg['connected'] as boolean,
    connecting: msg['connecting'] as boolean,
    ...(notice !== undefined ? { notice: notice as string } : {}),
  };
}

/** The fields of a DOM event the overlay reads. `detail` is a click's count: 0 from the keyboard. */
export interface OverlayEvent {
  readonly type: string;
  readonly detail?: number;
  readonly key?: string;
  readonly code?: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface GeometryOverlayDeps<E, V extends OverlayEvent = OverlayEvent> {
  /**
   * The panel itself, an `E` like every other element here: `hidden` is touched through
   * `setHidden` and its `keydown` is listened to. NOT `{hidden: boolean}` on the element type,
   * which a real element is REJECTED as -- lib.dom types `hidden` as `boolean | "until-found"`
   * (measured: TS2322 at `bridge.ts`, twice, for both spellings).
   */
  readonly element: E;
  readonly setHidden: (el: E, hidden: boolean) => void;
  readonly isHidden: (el: E) => boolean;
  /** Where the two radio groups are built. */
  readonly root: E;
  /** The one-line status: the connected line, or a notice. */
  readonly status: E;
  readonly create: (tag: string) => E;
  readonly append: (parent: E, child: E) => void;
  readonly setText: (el: E, text: string) => void;
  readonly setAttr: (el: E, name: string, value: string) => void;
  readonly setChecked: (el: E, on: boolean) => void;
  readonly setDisabled: (el: E, on: boolean) => void;
  /** Subscribe `fn` to `types` on `el` -- `addEventListener` in the page, a fake in the tests. */
  readonly listen: (el: E, types: readonly string[], fn: (e: V) => void) => void;
  /** One JSON text frame to the gateway, on the page's own socket. */
  readonly send: (text: string) => void;
}

export interface GeometryOverlay {
  /** Show if hidden, hide if shown. */
  toggle(): void;
  /** Hide it. Idempotent, so a second close cannot re-show. */
  hide(): void;
  /** Is it shown? `bridge.ts` reads this for the one-surface-at-a-time rule. */
  visible(): boolean;
  /** The gateway's latest `geometryChoices`. */
  update(choices: GeometryChoices): void;
}

export function createGeometryOverlay<E, V extends OverlayEvent = OverlayEvent>(
  deps: GeometryOverlayDeps<E, V>,
): GeometryOverlay {
  let latest: GeometryChoices | undefined;
  let radios: Array<{ el: E; group: 'model' | 'oversize'; name: string }> | undefined;
  deps.setHidden(deps.element, true);

  const hide = (): void => { deps.setHidden(deps.element, true); };
  // Escape, or Alt+M from inside -- see the header. Registered at construction: it costs one
  // listener and needs no radios.
  deps.listen(deps.element, ['keydown'], (e) => {
    const altM = e.code === 'KeyM' && e.altKey === true && e.ctrlKey !== true && e.metaKey !== true;
    if (e.key !== 'Escape' && !altM) return;
    e.preventDefault();
    e.stopPropagation();
    hide();
  });

  const pick = (which: 'model' | 'oversize', name: string): void => {
    if (latest === undefined || latest.connected) return;
    deps.send(JSON.stringify(which === 'model'
      ? { kind: 'setGeometry', model: name }
      : { kind: 'setGeometry', oversize: name }));
  };

  const group = (legend: string, which: 'model' | 'oversize', items: readonly Choice[]): void => {
    const set = deps.create('fieldset');
    const title = deps.create('legend');
    deps.setText(title, legend);
    deps.append(set, title);
    for (const item of items) {
      const label = deps.create('label');
      const input = deps.create('input');
      deps.setAttr(input, 'type', 'radio');
      deps.setAttr(input, 'name', `geometry-${which}`);
      deps.setAttr(input, 'value', item.name);
      const text = deps.create('span');
      deps.setText(text, item.label);
      deps.append(label, input);
      deps.append(label, text);
      deps.append(set, label);
      // A POINTER click only (`detail >= 1`), or Enter/Space -- never `change`; see the header.
      deps.listen(input, ['click', 'keydown'], (e) => {
        if (e.type === 'click') {
          if ((e.detail ?? 0) >= 1) pick(which, item.name);
          return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
          // Enter: nothing else wants it, and it must not reach the page. Space: its own default
          // still checks the radio; the keyboard click that follows carries `detail` 0 and is
          // ignored above, so the pick is sent once.
          if (e.key === 'Enter') e.preventDefault();
          pick(which, item.name);
        }
      });
      radios!.push({ el: input, group: which, name: item.name });
    }
    deps.append(deps.root, set);
  };

  /** Build the radios from `latest`, once, and only while shown -- see the header. */
  const ensureBuilt = (): void => {
    if (radios !== undefined || latest === undefined || deps.isHidden(deps.element)) return;
    radios = [];
    group('Model', 'model', latest.models);
    group('Oversize', 'oversize', latest.oversizes);
  };

  const render = (): void => {
    if (latest === undefined) return;
    deps.setText(deps.status, latest.notice
      ?? (latest.connecting ? CONNECTING_LINE : latest.connected ? CONNECTED_LINE : ''));
    ensureBuilt();
    for (const r of radios ?? []) {
      const on = r.group === 'model' ? latest.current.model : latest.current.oversize;
      deps.setChecked(r.el, r.name === on);
      deps.setDisabled(r.el, latest.connected);
    }
  };

  return {
    toggle: () => {
      deps.setHidden(deps.element, !deps.isHidden(deps.element));
      render();
    },
    hide,
    visible: () => !deps.isHidden(deps.element),
    update: (choices) => {
      latest = choices;
      render();
    },
  };
}
