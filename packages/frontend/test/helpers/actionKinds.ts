/**
 * Every `kind` in the `Action` union, read out of its DECLARATION at run time.
 *
 * ## WHY A SOURCE SCAN AND NOT A TYPE
 *
 * Both users of this need the list as a RUNTIME value -- one iterates it over a live WebSocket,
 * the other checks a dispatch table against it -- and there is no such value to import: `Action`
 * is a type-only union, `applyAction`'s `satisfies never` proves exhaustiveness inside the
 * `switch` and nowhere else, and NO TEST FILE IN THIS REPO IS TYPECHECKED (every `tsconfig.json`
 * includes only `src/**\/*.ts`, and vitest strips types rather than checking them), so a
 * type-level trick in a test would compile to nothing and enforce nothing. Hand-listing the kinds
 * would rot the moment someone adds a member -- which is the exact failure both callers exist to
 * prevent -- so the declaration is parsed instead. `web/src/main.ts`'s `tokenMatches` case and
 * `web/test/renderer-imports.test.ts` already read source for properties no assertion can
 * otherwise see.
 *
 * ## WHY IT IS SHARED RATHER THAN COPIED
 *
 * `web/test/integration.test.ts` had this scan first, for its own "the gateway answers every
 * kind" test; `frontend/test/actions.test.ts` needs the identical list for its dispatch table.
 * A second copy of a regex this fragile is two things to keep in step: the bounding to the
 * union's own declaration below is the whole reason the scan is trustworthy, and a copy that
 * lost it would still pass. `core/test/helpers/trace.ts` is the precedent for a shared test
 * helper, and it exists for the same reason -- one parser, not two that can diverge.
 *
 * A FLOOR AND CANARIES ARE ASSERTED BY EACH CALLER, using the two constants below: a scan that
 * silently stopped matching would otherwise leave a caller iterating an empty list and passing.
 */
import { readFileSync } from 'node:fs';

/**
 * The kinds, in declaration order.
 *
 * Read from `frontend/src/keymap.ts` relative to THIS file, so the path does not depend on which
 * package's test is asking.
 */
export function actionKinds(): readonly string[] {
  const source = readFileSync(new URL('../../src/keymap.ts', import.meta.url), 'utf8');
  // Bounded to the union's own declaration, so a `{ kind: 'x' }` in a doc comment or a table
  // elsewhere in that file cannot smuggle in a kind the type does not have.
  const union = /export type Action =([\s\S]*?);\n/.exec(source);
  if (union === null) throw new Error('cannot find the `Action` union in frontend/src/keymap.ts');
  return [...union[1]!.matchAll(/\|\s*\{\s*kind:\s*'([A-Za-z]+)'/g)].map((m) => m[1]!);
}

/**
 * A FLOOR, not an equality: adding an action must not fail a caller's sanity check, but a scan
 * that stopped matching must. 25 members at the time of writing -- 24 until `newline` joined,
 * which this floor deliberately did not need to move for.
 *
 * A caller that needs an EXACT count -- the dispatch table does, because a union member with no
 * row is the defect it exists to catch -- compares against its own rows instead.
 */
export const ACTION_KIND_FLOOR = 24;

/**
 * Named kinds the scan must find. A floor alone passes on a regex that matched 24 of the wrong
 * things; these are the shapes that differ -- one with a numeric field, one with text, the two
 * `applyAction` refuses or intercepts, and one plain member.
 */
export const ACTION_KIND_CANARIES: readonly string[] =
  ['pf', 'type', 'toggleKeypad', 'quit', 'fieldMark'];
