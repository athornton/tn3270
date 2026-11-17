/** Types for `parity.mjs`, so the tests that import it are typechecked too. */
import type { Inventory } from './parity-extract.mjs';
export type Area = 'connection' | 'keyboard' | 'display' | 'files' | 'scripting' | 'other';
export type Status = 'ours' | 'partial' | 'missing' | 'proposed-deferred' | 'proposed-skipped' | 'deferred' | 'skipped';
export interface Row {
  id: string; area: Area; title: string; covers: string[]; x3270: string; gui: string; status: Status;
  gap?: string; reason?: string; decided?: string;
  category?: 'x11-only' | 'obsolete' | 'declined' | 'n/a';
  evidence?: { code?: string[]; tests?: string[]; live?: string };
  'accept-unwitnessed'?: string;
  browser?: string; others?: Record<string, string>;
}
export const AREAS: Area[];
export const STATUSES: Status[];
export const CATEGORIES: string[];
export function check(args: { rows: Row[]; names: Pick<Inventory, 'names'>; root: string }): { problems: string[]; uncovered: string[] };
export function loadRows(text: string): Row[];
export function cell(s: unknown): string;
export function blocking(rows: Row[]): string[];
export function render(rows: Row[], names: Pick<Inventory, 'tag' | 'names'>): string;
/** Lets a caller inject the checklist, the inventory and the repo root (or alternate file
 * paths), and how `render` writes its output, so `main` is testable without touching the real
 * committed files. */
export interface MainDeps {
  root?: string;
  names?: Pick<Inventory, 'tag' | 'names'>;
  rows?: Row[];
  namesFile?: string;
  rowsFile?: string;
  mdFile?: string;
  writeFile?: (path: string, data: string) => void;
}
export function main(
  argv: string[],
  io?: { log: (s: string) => void; err: (s: string) => void },
  deps?: MainDeps,
): number;
/** Whether a `path.relative(root, x)` result leaves the root, in either separator. */
export function escapesRoot(rel: string): boolean;
