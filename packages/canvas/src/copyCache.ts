import type { CellRect } from './selection.js';

/**
 * THE PREFETCHED TEXT OF THE CURRENT SELECTION, so a `copy` event can hand it over synchronously.
 * 2026-11-02.
 *
 * WHY IT EXISTS: the browser's own copy path (`clipboardData.setData` inside a `copy` event) needs
 * no secure context and no user-activation window, but it needs the text NOW, and only the gateway
 * can extract it. So the renderer asks when a drag ends and keeps the answer here. See
 * `docs/superpowers/specs/2026-11-02-fetch-ahead-copy-design.md` for the measurement behind it.
 *
 * DOM-FREE AND STATE-ONLY, like `selection.ts`, so it is tested under `environment: 'node'`.
 *
 * THE GENERATION, NOT TIMING, IS WHAT KEEPS A STALE ANSWER OUT. `invalidate()` and every `begin()`
 * bump it, and `accept` drops any answer whose generation is not current -- including one for the
 * same rect over a screen that has since changed.
 *
 * IN `invalidate()` THE THREE LINES ARE NOT EQUIVALENT, MEASURED 2026-11-03 by keeping each one
 * alone against two probes (text accepted BEFORE the invalidate; an answer accepted AFTER it):
 *   - the gen bump alone leaves already-accepted text readable -- `take` never looks at `gen`;
 *   - clearing `text` alone lets a late `accept` for the old gen repopulate it, and `take` then
 *     returns it, because `asked` still names the rect;
 *   - clearing `asked` alone passes both, since `take` refuses without it -- the one line that
 *     suffices by itself.
 * The other two are kept anyway: the gen bump is what stops a late answer landing in `text` at all,
 * which keeps the state honest for whoever reads it next, and clearing `text` drops the string.
 */
export interface CopyCache {
  /** A drag ended on `rect`. Returns the generation its answer must carry. */
  begin(rect: CellRect): number;
  /** The answer for generation `gen`. Ignored unless `gen` is still current, or if `text` is empty. */
  accept(gen: number, text: string): void;
  /** The selection is gone or the screen changed. A pending answer becomes stale. */
  invalidate(): void;
  /** The text for `rect`, or `undefined`. Does not consume: the selection survives a copy. */
  take(rect: CellRect): string | undefined;
}

export function createCopyCache(): CopyCache {
  let gen = 0;
  let asked: CellRect | undefined;
  let text: string | undefined;
  const same = (a: CellRect, b: CellRect): boolean =>
    a.top === b.top && a.left === b.left && a.bottom === b.bottom && a.right === b.right;
  return {
    begin(rect) {
      gen += 1;
      asked = { ...rect };
      text = undefined;
      return gen;
    },
    accept(g, t) {
      // EMPTY ('') IS NOT CACHED: see the test. Only a one-row all-blank rect extracts '';
      // `extractText` joins rows with '\n', so a blank multi-row rect extracts '\n', which IS
      // cached here, matching the old path (`web/src/main.ts`'s `copy` arm sends when
      // `text !== ''`). An uncached '' copy falls back, which sends nothing.
      if (g !== gen || t === '') return;
      text = t;
    },
    invalidate() {
      gen += 1;
      asked = undefined;
      text = undefined;
    },
    take(rect) {
      if (asked === undefined || text === undefined || !same(asked, rect)) return undefined;
      return text;
    },
  };
}
