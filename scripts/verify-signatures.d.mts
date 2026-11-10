/** Types for `verify-signatures.mjs`, so the tests that import it are typechecked too. */
export type Expect = 'signed' | 'unsigned';
/** A command's exit status and its stdout+stderr together (codesign and spctl report on stderr). */
export interface Ran { status: number; text: string }
export function parseCodesignDisplay(text: string): { authorities: string[]; teamId: string | undefined; runtime: boolean; adhoc: boolean };
export function judgeMacApp(r: { verify: Ran; display: Ran; spctl: Ran; stapler: Ran }, expect: Expect, teamId: string | undefined): string[];
export function parseAuthenticode(text: string): { status: string; subject: string };
export function judgeWinFile(sig: { status: string; subject: string }, expect: Expect, publisher: string | undefined): string[];
