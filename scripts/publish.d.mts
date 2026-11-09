/** Types for `publish.mjs`, so the tests that import it are typechecked too. */
export interface Tarball {
  path: string;
  name: string;
  version: string;
  /** `@tn3270/*` dependencies only, name -> range, from every field npm installs from. */
  deps: Record<string, string>;
  /** sha1 of the whole .tgz, hex: what the registry records as `dist.shasum`. */
  sha1: string;
}
/** The slice of `fetch` this script uses, so tests can fake it. */
export type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export type Decision = 'publish' | 'skip' | 'conflict';

export function readTarball(path: string): Tarball;
export function publishOrder(tarballs: Tarball[]): Tarball[];
export function checkRelease(args: { tag: string | undefined; tarballs: Tarball[]; expectedNames: string[] }):
  { version: string | undefined; problems: string[] };
export function registryShasum(fetchFn: FetchFn, name: string, version: string, opts?: { timeoutMs?: number }): Promise<string | undefined>;
export function decide(localSha1: string, registrySha1: string | undefined): Decision;
export function verifyReadBack(fetchFn: FetchFn, tarballs: Tarball[], version: string,
  opts?: { attempts?: number; delayMs?: number; deadlineMs?: number; timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>; now?: () => number }): Promise<string[]>;
export const ALREADY_PUBLISHED: RegExp;
export function main(argv: string[], io: {
  env: Record<string, string | undefined>;
  fetchFn: FetchFn;
  /** `output` is collected only with `capture` (the dry runs); otherwise npm's stdio is inherited. */
  run: (args: string[], opts: { capture: boolean }) => { status: number; output: string };
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}): Promise<number>;
