/** Types for `bundleVerify.mjs`, so the tests that import it are typechecked too. */
export const DOCUMENTS: readonly string[];
export class BundleError extends Error {}
export function verify(outDir: string): void;
export const BUNDLE_PACKAGES: readonly string[];
export const BUNDLE_GUI_FILES: readonly string[];
export function bundleStaleness(packagesRoot: string): { why: string; forceHint: string } | undefined;
