/**
 * The connect dialog's form, turned into the argv the user would have typed.
 *
 * ONE PARSER: the result goes through `parseGuiArgs` exactly as a real command line does, so
 * the dialog cannot accept a host the command line refuses or refuse one it accepts. This
 * function validates NOTHING -- an empty host becomes no host argument, and `parseGuiArgs`
 * says what is wrong in the words it always uses. See
 * docs/superpowers/specs/2026-11-05-packaging-design.md section 2.
 */
export interface ConnectForm {
  readonly host: string;
  readonly model: string;
  readonly tls: boolean;
}

/**
 * Flags the form owns outright. A copy on the real command line is dropped so the form's own
 * choice -- the model dropdown, the TLS checkbox -- is the one `parseGuiArgs` sees, never a
 * stale value left over from how the GUI happened to be launched.
 *
 * `-insecure` is the ONLY TLS flag the form owns. `-cafile`, `-noverifycert` and `-verifycert`
 * are not: the dialog has no field for them, so a command line that set one is left alone, and
 * stays exactly as liable to the parser's own TLS contradictions (e.g. `-cafile` plus the form's
 * TLS checkbox unticked, which becomes `-insecure` alongside `-cafile` -- `resolveTls`'s
 * contradiction, not a second one invented here).
 */
const OWNED_WITH_VALUE = new Set(['-model']);
const OWNED_BARE = new Set(['-insecure']);

/**
 * Drops the command line's copies of the flags the form owns.
 *
 * Walks `commandLine` left to right rather than searching for `-model` and splicing: a flag's
 * value is identified by POSITION (the token right after it), the same way `parseGuiArgs`
 * itself reads argv, so this can never mistake an unrelated token for one flag's value or vice
 * versa.
 *
 * A `-model` with no value cannot reach here: `parseGuiArgs` throws "-model needs a value" before
 * it looks for a host, so that command line fails at startup and the dialog never opens.
 */
function dropOwned(commandLine: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < commandLine.length; i++) {
    const flag = commandLine[i]!;
    if (OWNED_BARE.has(flag)) continue;
    if (OWNED_WITH_VALUE.has(flag)) {
      i++; // also drop the value that goes with it
      continue;
    }
    kept.push(flag);
  }
  return kept;
}

export function dialogToArgv(form: ConnectForm, commandLine: readonly string[]): string[] {
  const kept = dropOwned(commandLine);
  const host = form.host.trim();
  return [
    ...kept,
    ...(form.tls ? [] : ['-insecure']),
    '-model', form.model,
    ...(host === '' ? [] : [host]),
  ];
}
