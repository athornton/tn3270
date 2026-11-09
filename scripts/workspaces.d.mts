/** Types for `workspaces.mjs`, so the tests that import it are typechecked too. */
export interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  files?: string[];
  dependencies?: Record<string, string>;
}
export function publishedPackages(): Array<{ dir: string; m: Manifest }>;
export function tarballName(m: { name: string; version: string }): string;
