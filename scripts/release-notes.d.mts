/** Types for `release-notes.mjs`, so the tests that import it are typechecked too. */
export function expectedInstallers(v: string): string[];
export function installersFor(v: string, platform: string, arch: string): string[];
export function checkInstallers(files: string[], v: string, expected?: string[]): string[];
export function sha256sums(entries: { name: string; sha256: string }[]): string;
export function previousTag(tags: string[], version: string): string | undefined;
export function composeNotes(args: {
  version: string; repo: string; previous: string; scriv: string; commits: string;
  /** `releases/generate-notes`'s `body`; left out when it lists no pull requests. */
  pulls?: string;
}): string;
export function changelogProblems(args: {
  version: string; scrivExit: number; scrivText: string; fragmentDir: string; entries: string[];
}): string[];
