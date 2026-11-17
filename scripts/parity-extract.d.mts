/** Types for `parity-extract.mjs`, so the tests that import it are typechecked too. */
export function makeVar(text: string, name: string): string[];
export function parseDefines(text: string): Map<string, string>;
export function linkedSources(read: (path: string) => string): string[];
export function guardsByLine(text: string): (string | null)[];
