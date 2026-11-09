/** Types for `release-notes.mjs`, so the tests that import it are typechecked too. */
export function expectedInstallers(v: string): string[];
export function installersFor(v: string, platform: string, arch: string): string[];
export function checkInstallers(files: string[], v: string, expected?: string[]): string[];
export function escapeMarkdown(text: string): string;
/** `git log --format=%s%x00%h` output -> `- subject (hash)` markdown lines. */
export function commitList(gitLog: string): string;
export function sha256sums(entries: { name: string; sha256: string }[]): string;
export function previousTag(tags: string[], version: string): string | undefined;
export function composeNotes(args: {
  version: string; repo: string; previous: string; scriv: string; commits: string;
  /** `releases/generate-notes`'s `body`; its section is left out when it lists no pull requests. */
  pulls?: string;
}): string;
export function changelogProblems(args: {
  version: string; scrivExit: number; scrivText: string; fragmentDir: string; entries: string[];
}): string[];
/** `run`'s answer: the exit status and stdout (stderr is the caller's own). */
export interface RunResult { status: number; stdout: string }
export type Run = (cmd: string, args: string[], opts: { cwd: string }) => RunResult;
export function main(argv: string[], io: {
  env: Record<string, string | undefined>;
  run: Run;
  log: (line: string) => void;
  /** The repository root: changelog.d, package.json, and where release-notes.md is written. */
  root?: string;
  platform?: string;
  arch?: string;
}): number;
export const runCommand: Run;
