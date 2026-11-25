import { parseModel } from '@tn3270/core';

let shown = false;

/**
 * THE ONE NOTICE FOR 15b B2's BREAKING CHANGE: a `3278-` model now means a mono 3278, as in x3270
 * (`Common/model.c:155`), where before 2026-11-24 it drew in color. Returned the first time a
 * 3278 name is given in this process and never again, so a deliberately saved mono preference
 * doesn't nag forever. Undefined for 3279, bare and absent names, and for anything unparseable
 * (the parser reports those).
 */
export function monoModelNotice(model: string | undefined): string | undefined {
  if (shown || model === undefined) return undefined;
  const p = parseModel(model);
  if (p === undefined || p.color) return undefined;
  shown = true;
  const color = `3279-${p.number}${p.extended ? '-E' : ''}`;
  return `-model ${model} now means a mono 3278, as in x3270; for color use ${color}`;
}

/** For tests only: forget that the notice was shown. */
export function resetMonoModelNotice(): void { shown = false; }
