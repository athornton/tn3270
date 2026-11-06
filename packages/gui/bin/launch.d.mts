/** Types for `launch.mjs`, so its test is typechecked. */
export const FORWARDED: readonly NodeJS.Signals[];
export function exitPlan(
  code: number | null,
  signal: NodeJS.Signals | null,
  platform?: NodeJS.Platform,
): { exit: number } | { raise: NodeJS.Signals };
export function electronMissing(err: unknown): string;
export function bundleMissing(path: string): string;
export function sandboxHint(chromeSandbox: string): string;
