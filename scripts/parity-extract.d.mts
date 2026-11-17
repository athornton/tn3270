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

export interface Inventory extends Extracted { source?: string; tag: string; missingSources: string[] }
export function newestGa(tags: string[]): string | undefined;
export function renderInventory(inv: Inventory): string;
export function diffNames(oldInv: Inventory, newInv: Inventory): string[];
export function inventory(root: string): Inventory;
export function fetchTag(tag: string): string;
export function withTag<T>(tag: string, fn: (root: string) => T): T;

/** Injected deps for `main`, so its --upstream decision logic is testable without the network:
 * `tags` replaces the GitHub tags fetch, `inventoryForTag` replaces
 * `(tag) => withTag(tag, inventory)` (used by --tag, and by --upstream for both a newer GA and
 * the re-extraction of the recorded tag). */
export interface MainDeps {
  tags?: () => Promise<string[]> | string[];
  inventoryForTag?: (tag: string) => Promise<Inventory> | Inventory;
}
/** Exit codes: 0 current/success, 1 a real difference (a newer GA upstream, a newer GA whose
 * linkage changed, or a committed inventory that doesn't match its own tag), 2 usage error, 3 any
 * other error (network, HTTP, bad JSON, bad tag, curl/tar failure). */
export function main(
  argv: string[],
  io?: { log: (s: string) => void; err: (s: string) => void },
  deps?: MainDeps,
): Promise<number>;
