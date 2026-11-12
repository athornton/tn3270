/**
 * The one stderr line a test seam prints when it cannot read or write the file it was given:
 * `replay: cannot read <path>: ENOENT no such file or directory`.
 *
 * WHY IT EXISTS: `TN3270_GUI_REPLAY` and `TN3270_GUI_SHOT` each do synchronous file I/O inside
 * `app.whenReady()`'s promise, where a throw is an unhandled rejection -- and the terminal window
 * is still open, so nothing quits. MEASURED on the store-probe MAS build: an EPERM on the trace
 * printed `UnhandledPromiseRejectionWarning` and then SAT until CI killed it at 60 s. The seams
 * now catch and exit; this is the line they exit with.
 *
 * THE CODE AND THE PATH ARE BOTH KEPT, and Node's own message is trimmed so neither appears twice:
 * `ENOENT: no such file or directory, open '/x'` becomes `ENOENT no such file or directory`, since
 * the path is already in the line. An error with no `code` is passed through whole.
 */
export function describeFileError(seam: string, verb: string, path: string, err: unknown): string {
  return `${seam}: cannot ${verb} ${path}: ${detail(err)}`;
}

function detail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const { code, syscall } = err as { code?: unknown; syscall?: unknown };
  if (typeof code !== 'string') return err.message;
  let text = err.message;
  if (text.startsWith(`${code}: `)) text = text.slice(code.length + 2);
  if (typeof syscall === 'string') {
    // `, open '/x'` or a bare `, read` -- the syscall Node appends, with the path when it has one.
    const suffix = new RegExp(`, ${syscall}( '.*')?$`);
    text = text.replace(suffix, '');
  }
  return `${code} ${text}`;
}
