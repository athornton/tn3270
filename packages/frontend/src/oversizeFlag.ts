import { parseOversize, OversizeError, type Oversize } from '@tn3270/core';

/**
 * `-oversize`, shared by every front end -- mirrors `tls.ts`'s `takeTlsFlag`, for the
 * same reason that file states: two copies of one rule is two things to keep in step.
 *
 * Parsing itself (`<cols>x<rows>`, `auto`, `none`) lives in `@tn3270/core`'s
 * `parseOversize` -- this is only the argv plumbing around it.
 */

/** Usage text for the flag, shared so the front ends cannot drift. */
export const OVERSIZE_USAGE = '[-oversize <cols>x<rows>|auto|none]';

/**
 * Consumes `-oversize` if `flag` is it, returning how many extra argv entries it ate
 * (always 1, for the value); returns undefined if the flag is none of ours, so the
 * caller's switch can fall through to its own handling -- same contract as `takeTlsFlag`.
 */
export function takeOversizeFlag(
  out: { oversize?: Oversize },
  flag: string,
  value: string | undefined,
  usage: (message: string) => Error,
): number | undefined {
  if (flag !== '-oversize') return undefined;
  if (value === undefined) {
    throw usage('-oversize needs a value: <cols>x<rows>, auto or none');
  }
  try {
    out.oversize = parseOversize(value);
  } catch (e) {
    if (e instanceof OversizeError) throw usage(e.message);
    throw e;
  }
  return 1;
}
