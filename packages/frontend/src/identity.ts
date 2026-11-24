import { createRequire } from 'node:module';
import { CODE_PAGE_NAMES, DEFAULT_CODE_PAGE, type ConnectionInfo } from '@tn3270/core';

/**
 * `--help`/`-?` or `--version`/`-v`, but ONLY as the lone argument, as x3270 has it
 * (`x3270/x3270.c:497-506`). With anything else alongside, the front end's parser sees them and
 * refuses them as it always has.
 */
export function infoFlag(argv: readonly string[]): 'help' | 'version' | undefined {
  if (argv.length !== 1) return undefined;
  const a = argv[0];
  if (a === '--help' || a === '-?') return 'help';
  if (a === '--version' || a === '-v') return 'version';
  return undefined;
}

/**
 * Line 3 of the repo's `LICENSE` plus the licence name. Written here rather than read from
 * `LICENSE`, which this package does not ship (`files` is dist and README); a test compares the
 * two so they cannot drift.
 */
export const COPYRIGHT = 'Copyright (c) 2026 Adam Thornton; MIT License';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

/**
 * The `--version` text, and the About window's first section. The runtime versions are
 * arguments (callers pass `process.versions`) so tests are deterministic. There is no build or
 * commit line: nothing in the build records one, and the spec says to omit it rather than invent it.
 */
export function versionText(
  frontend: string, versions: { readonly node: string; readonly openssl: string; readonly electron?: string },
): string {
  const node = versions.node.startsWith('v') ? versions.node : `v${versions.node}`;
  const pages = CODE_PAGE_NAMES.map((n) => (n === DEFAULT_CODE_PAGE.name ? `${n} (default)` : n)).join(', ');
  return [
    `tn3270-${frontend} ${pkg.version}`,
    `Node ${node}${versions.electron !== undefined ? `; Electron v${versions.electron}` : ''}`,
    `TLS: OpenSSL ${versions.openssl}`,
    `Code pages: ${pages}`,
    COPYRIGHT,
  ].join('\n');
}

/**
 * The window title, host first: taskbars and browser tabs truncate from the right, and the host
 * is what tells several windows apart. x3270's is `x3270-<model> <host>` (x3270/x3270.c:922-955).
 */
export function windowTitle(
  info: Pick<ConnectionInfo, 'connected' | 'host' | 'port' | 'lu' | 'terminalType'>,
): string {
  if (!info.connected || info.host === undefined) return 'TN3270 — not connected';
  const where = `${info.host}${info.port !== undefined ? `:${info.port}` : ''}${info.lu !== undefined ? ` [${info.lu}]` : ''}`;
  const model = info.terminalType?.replace(/^IBM-/, '');
  return `${where} — TN3270${model !== undefined ? ` ${model}` : ''}`;
}
