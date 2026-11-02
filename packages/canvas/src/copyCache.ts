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
      // EMPTY IS NOT CACHED: see the test. An all-blank copy then falls back, which sends nothing.
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
