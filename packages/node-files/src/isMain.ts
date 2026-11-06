import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module at `metaUrl` is the program Node was asked to run.
 *
 * REPLACES `import.meta.url === \`file://${process.argv[1]}\``, which the TUI and the web gateway
 * used, and which is FALSE for every installed copy: npm installs a bin as a symlink on POSIX
 * and as a `.cmd` shim on Windows, so `argv[1]` names the link, not the file; and on Windows a
 * path has a drive letter and backslashes that no `file://` concatenation reproduces. The
 * program then exits 0 having done nothing. Comparing REAL paths handles all three: a Windows
 * `.cmd` shim runs `node "<path>\main.js"`, so `argv[1]` is already the real file there, and
 * `realpathSync` resolving a POSIX symlink is exactly what the old string comparison could not do.
 *
 * `argv1` is a parameter only so the tests need not mutate `process.argv`.
 */
export function isMain(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
