/**
 * THE GUI'S `ipcMain.on('action')` FUNNEL, its guard half, pure and out of main.ts because vitest
 * cannot load `electron`.
 *
 * WHY IT EXISTS. The keypad and keyboard windows forward whatever `actionForKey` returns with no
 * kind filtering (`canvas/src/forwardKeys.ts`), and `applyAction` deliberately THROWS on the kinds
 * a front end must own (`frontend/src/actions.ts`). A throw in that listener did not merely log: on
 * 2026-10-27 it FROZE THE MAIN PROCESS, which then ignored SIGTERM. The arms in main.ts intercept
 * every kind known to throw today; this guard is what makes the NEXT one survivable.
 *
 * LOUD, NOT FATAL. The throws exist so a front end that forgot an arm fails loudly rather than
 * having an inert key. This keeps that: the drop is reported, by kind, on every run. The line
 * carries our own error message and the action's kind, never screen content, so it may be printed
 * ungated.
 */

/** An IPC payload worth dispatching: an object with a non-empty string `kind`. */
export function isActionShaped(v: unknown): v is { readonly kind: string } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    && typeof (v as { kind?: unknown }).kind === 'string' && (v as { kind: string }).kind !== '';
}

/** Apply `action`; on a throw, report `action dropped: KIND: message` and return false. */
export function applyGuarded<A extends { readonly kind: string }>(
  apply: (action: A) => void, action: A, report: (line: string) => void,
): boolean {
  try {
    apply(action);
    return true;
  } catch (err) {
    report(`action dropped: ${action.kind}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
