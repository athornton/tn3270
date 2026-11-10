/** Types for `verify-signatures.mjs`, so the tests that import it are typechecked too. */
export type Expect = 'signed' | 'unsigned';
/** A command's exit status and its stdout+stderr together (codesign and spctl report on stderr). */
export interface Ran { status: number; text: string }
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
