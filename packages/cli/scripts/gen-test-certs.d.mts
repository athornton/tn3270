/** Types for `gen-test-certs.mjs`, so the tests that import it are typechecked too. */
export function haveOpenssl(): boolean;
export function generateCerts(
  dir: string,
  opts?: { days?: number; cn?: string },
): { certPath: string; keyPath: string; certPem: Buffer };
