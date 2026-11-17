/** Types for `parity-extract.mjs`, so the tests that import it are typechecked too. */
export function makeVar(text: string, name: string): string[];
export function parseDefines(text: string): Map<string, string>;
export interface Linked { sources: string[]; missingSources: string[] }
export function linkedSources(read: (path: string) => string): Linked;
export function guardsByLine(text: string): (string | null)[];

export interface Site { at: string; guard: string | null }
export interface Name { id: string; kind: 'action' | 'xaction' | 'option' | 'resource' | 'toggle' | 'menu'; value: string; sites: Site[]; resource?: string }
export interface Extracted { names: Name[]; unresolved: string[]; nonLiteralMenuCalls: string[]; privateXactions: number }
export function extractNames(read: (path: string) => string, files: string[]): Extracted;
