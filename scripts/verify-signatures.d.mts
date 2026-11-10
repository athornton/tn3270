/** Types for `verify-signatures.mjs`, so the tests that import it are typechecked too. */
export type Expect = 'signed' | 'unsigned';
/**
 * A command's exit status, its stdout+stderr together in `text` (codesign and spctl report on
 * stderr), and stdout alone (what the Authenticode JSON is parsed from).
 */
export interface Ran { status: number; stdout: string; text: string }
export function parseCodesignDisplay(text: string): { authorities: string[]; teamId: string | undefined; runtime: boolean; adhoc: boolean };
export function judgeMacApp(r: { verify: Ran; display: Ran; spctl: Ran; stapler: Ran }, expect: Expect, teamId: string | undefined): string[];
export function parseAuthenticode(text: string): { status: string; subject: string };
export function judgeWinFile(sig: { status: string; subject: string }, expect: Expect, publisher: string | undefined): string[];
export type Run = (cmd: string, args: string[], opts?: { verbatim?: boolean }) => Ran;
export function main(argv: string[], io: {
  env: Record<string, string | undefined>; run: Run; log: (line: string) => void; platform: string;
  /** Lists a directory (default readdirSync); injectable so main() is testable without artifacts. */
  list?: (dir: string) => string[];
  /** Makes a scratch directory (default a fresh tmpdir one, removed afterwards); an injected one is left alone. */
  scratch?: () => string;
  /** existsSync, injectable for the unpacked-app and installed-file checks. */
  exists?: (path: string) => boolean;
}): number;
export const runCommand: Run;
/** runCommand's spawnSync options (exported so the 10-minute timeout is pinned by a test). */
export function spawnOptions(cmd: string, opts?: { verbatim?: boolean }): {
  encoding: 'utf8'; timeout: number; windowsHide: boolean; maxBuffer: number;
  windowsVerbatimArguments?: boolean; argv0?: string;
};
