/** Types for `xvfb.mjs`, so the tests that import it are typechecked too. */
export const electron: string;
export function ensureDisplay(): string;
export function guiEnv(extra?: Record<string, string | undefined>): Record<string, string | undefined>;
export function guiMain(): string;
export function guiMainLabel(): string;
export interface StalenessProblem {
  why: string;
  fix: string;
}
export function staleness(
  main: string,
  pkgs: readonly string[],
  packagesRoot?: string,
): StalenessProblem | undefined;
