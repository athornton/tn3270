/** Types for `package-checks.mjs`, so the tests (and store-probe's) that import it are typechecked too. */
export interface Staged { trace: string; shot: string; userData: string }
/** A route the checks launch; see "THE ROUTE" in package-checks.mjs. */
export interface Route {
  exe: string;
  prefix: string[];
  env: Record<string, string>;
  installDir?: string;
  /** Windows: where the survivor check looks (by ExecutablePath). Default `installDir`. */
  processDir?: string;
  /** Where a launch's trace, capture and userData live; `dir` is its fresh directory. Default `defaultStage`. */
  stage?: (dir: string) => Staged;
  /** Adds TN3270_GUI_PROBE=1 and returns the `probe:` line seen. Default false. */
  probe?: boolean;
}
/** A check's result: `note` for the ok line, `probe` the last `probe:` line (null unless `route.probe`). */
export interface CheckResult { note: string; probe: string | null }
export type Check = (route: Route, work: string) => Promise<CheckResult>;
export const TRACE: string;
export const GOLDEN: string;
export const GOLDEN_PNG: string;
export const LAUNCH_MS: number;
export const NO_SEAMS: Readonly<Record<string, string>>;
export function defaultStage(dir: string): Staged;
export function routeDefaults(route: Route): {
  stage: (dir: string) => Staged; probe: boolean; processDir: string | undefined;
};
export function switches(userData: string): string[];
/** A started launch (smoke-lib's `launch`): output growing as it runs. */
export interface Started {
  child: import('node:child_process').ChildProcessWithoutNullStreams; stdout: string; stderr: string; exited: boolean;
  closed: Promise<{ code: number | null; signal: string | null }>;
}
/** Starts the route's app (NO_SEAMS, the probe seam, TN3270_GUI_MAIN and APP_SANDBOX_CONTAINER_ID removed). */
export function start(route: Route, args: string[], extraEnv: Record<string, string>, cwd: string): Promise<Started>;
export function probeSeen(stdout: string): string | null;
export function winProcessesUnder(dir: string): string[];
export const drawsGolden: Check;
export const dialogConnects: Check;
export const CHECKS: ReadonlyArray<readonly [string, Check]>;
