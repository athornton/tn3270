/** Types for `store-probe.mjs`, so the tests that import it are typechecked too. */
import type { Route } from './package-checks.mjs';

export const BUNDLE_ID: string;
export const TEAM_ID: string;
export const IDENTITY_NAME: string;
export const PUBLISHER: string;
export function containerPath(home: string): string;

/** A parsed `probe:` line: `sandbox` null for `sandbox=none`. */
export interface Probe { sandbox: string | null; windowsStore: boolean }
export function parseProbeLine(stdout: string | null | undefined): Probe | null;
export function judgeMacConfinement(
  seen: { entitlements: string; containerExists: boolean; probe: Probe | null }, bundleId: string,
): string[];
export function judgeSignatureVerify(text: string, rc: number): string[];
export interface AppxPackage { name: string; packageFamilyName: string; packageFullName: string; installLocation: string }
export function parseAppxPackage(text: string): AppxPackage | null;
export function judgeWinConfinement(
  seen: { pkg: AppxPackage | null; probe: Probe | null; started: string | null }, identityName: string,
): string[];

/** What the routes need of `io`: the home directory, and (mac) a way to stage the trace. */
export interface RouteIo {
  home: string;
  fs: { mkdir: (dir: string) => void; copy: (from: string, to: string) => void };
  /** The input trace; default package-checks' TRACE. */
  trace?: string;
}
export function macRoute(io: RouteIo, app: string): Route;
export function winRoute(io: Pick<RouteIo, 'trace'>, where: { alias: string; installLocation: string }): Route;
