/** Types for `store-probe.mjs`, so the tests that import it are typechecked too. */
import type { Check, Route } from './package-checks.mjs';

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
export function judgeProbeMac(probe: Probe | null, bundleId: string): string[];
export function judgeProbeWin(probe: Probe | null): string[];

/** smoke-lib's CheckFailed, re-exported: what a check throws for its FAIL. */
export class CheckFailed extends Error {}

export const SDK_BIN: string;
export function newestSdkTool(names: string[], exists: (path: string) => boolean, tool?: string): string | null;
export function parsePackageFullName(text: string): string | null;

/** verify-signatures' Ran: exit status, stdout alone, and stdout+stderr in `text`. */
export interface Ran { status: number; stdout: string; text: string }
/** `show`: what STORE_PROBE_ECHO logs instead of the command line (a PowerShell script, not its base64). */
export type Run = (cmd: string, args: string[], opts?: { verbatim?: boolean; show?: string }) => Ran;
export interface Fs {
  exists: (path: string) => boolean;
  list: (dir: string) => string[];
  copy: (from: string, to: string) => void;
  rm: (path: string) => void;
  mkdir: (dir: string) => void;
  /** A fresh scratch directory `<parent>/<prefix>XXXXXX`; `parent` defaults to the OS temp dir. */
  mkdtemp: (prefix: string, parent?: string) => string;
  read: (path: string) => string;
  write: (path: string, text: string) => void;
}
export const nodeFs: Readonly<Fs>;
export function removeContainer(io: { home: string; fs: Pick<Fs, 'rm' | 'exists'> }, path: string): void;

/** One confinement launch: its output, what `whileRunning(pid)` said, and any survivor of the kill. */
/** `held`: after its probe line the app showed the Connect dialog, or still ran STAY_MS later. */
export interface Launched { stdout: string; stderr?: string; during: string | null; held: boolean; pid?: number; survivors: string[] }
export type Launch = (route: Route, args: string[], opts: { work: string; whileRunning?: (pid: number) => string | null; stayMs?: number }) => Promise<Launched>;
export const STAY_MS: number;
export const launchForProbe: Launch;

export interface Io {
  run: Run;
  fs: Fs;
  platform: string;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  home: string;
  /** Default launchForProbe. */
  launch?: Launch;
  /** Default package-checks' CHECKS. */
  checks?: ReadonlyArray<readonly [string, Check]>;
  trace?: string;
  now?: () => number;
  /** The pfx password (default a random UUID). */
  secret?: () => string;
}
export function main(argv: string[], io: Io): Promise<number>;

export function psQuote(s: string): string;
export function setTeamId(app: string, run: Run): string[];
export function signInsideOut(app: string, ent: { main: string; inherit: string; login: string }, io: { run: Run; fs: Pick<Fs, 'exists' | 'list'> }): string[];
export function pidsUnder(psOutput: string, work: string): string[];
export const PS_PREAMBLE: string;
export function psInstalled(): string;
export function parseInstalled(text: string): string[];
export function psCertificate(o: { pfx: string; cer: string; password: string }): string;
export function psInstall(appx: string): string;
export function psListPackage(): string;
export function psAlias(): string;
export function psPackageOfPid(pid: number): string;
export function psReap(installLocation: string | null, pids: number[]): string;
export function psUninstall(fullName: string): string;
export function psRemoveCert(store: string, thumbprint: string | null): string;
