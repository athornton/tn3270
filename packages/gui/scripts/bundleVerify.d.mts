/** Types for `bundleVerify.mjs`, so the tests that import it are typechecked too. */
export const DOCUMENTS: readonly string[];
export class BundleError extends Error {}
export function verify(outDir: string): void;
