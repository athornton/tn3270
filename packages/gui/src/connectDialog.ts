import { KNOWN_MODELS, resolveTerminalType, TerminalTypeError } from '@tn3270/core';
import { MissingHostError, parseGuiArgs, UsageError, type GuiArgs } from './args.js';
import { dialogToArgv, type ConnectForm } from '@tn3270/frontend';

/**
 * The decidable half of the startup Connect dialog: when it opens, what a submit means, and what
 * its test seam says. Spec docs/superpowers/specs/2026-11-05-packaging-design.md section 2.
 *
 * HERE AND NOT IN main.ts for the reason `buildSession` is in args.ts: main.ts imports `electron`,
 * which vitest cannot load, so a decision left there could only be tested by copying it.
 */

/** The model the dialog's dropdown starts on: the GUI's own flagless default. */
export const CONNECT_DEFAULT_MODEL = '3278-2-E';

/** What the dialog's dropdown lists, sent to the renderer by main -- the page imports no core. */
export function connectModels(): { readonly models: readonly string[]; readonly default: string } {
  return { models: Object.keys(KNOWN_MODELS), default: CONNECT_DEFAULT_MODEL };
}

/** What startup does with the command line it was given. */
export type StartupPlan =
  | { readonly kind: 'session'; readonly args: GuiArgs }
  | { readonly kind: 'dialog' }
  | { readonly kind: 'fail'; readonly err: unknown };

/**
 * Session, dialog or failure, from the command line and the seams that stand in for a host.
 *
 * THE DIALOG OPENS ONLY FOR `MissingHostError`, never for a usage error in general: a bad flag with
 * no host is that flag's error, as it always was, and `parseGuiArgs` checks oversize and TLS BEFORE
 * the host so those are bad-flag errors too.
 *
 * TWO SEAMS KEEP THE OLD FAILURE, because a dialog nobody can answer under a harness is a HANG,
 * not a failure:
 *  - `TN3270_GUI_REPLAY`: a replay never dials, so a host it was not given is still the usage
 *    error it always was.
 *  - `TN3270_GUI_SHOT` WITHOUT `TN3270_GUI_CONNECT`: a87a3fd made every startup failure under the
 *    shot seam a fast non-zero exit, and a bare launch under it is one of those. With the connect
 *    seam set the dialog WILL be answered, so it opens.
 * `TN3270_GUI_URL` never gets here: main returns before argv is read in URL mode.
 *
 * `parse` is injectable only so a test can make it throw something that is not a usage error.
 */
export function planStartup(
  argv: readonly string[],
  seams: { readonly replay: string; readonly shot: string; readonly connect: string },
  parse: (argv: readonly string[]) => GuiArgs = parseGuiArgs,
): StartupPlan {
  try {
    return { kind: 'session', args: parse(argv) };
  } catch (err) {
    const unanswerable = seams.replay !== '' || (seams.shot !== '' && seams.connect === '');
    if (err instanceof MissingHostError && !unanswerable) return { kind: 'dialog' };
    return { kind: 'fail', err };
  }
}

/** The answer to one press of Connect. */
export type SubmitResult =
  | { readonly ok: true; readonly args: GuiArgs }
  | { readonly ok: false; readonly error: string };

/** The form's shape, checked: it arrived over IPC, so nothing about it is a type yet. */
function isConnectForm(form: unknown): form is ConnectForm {
  if (typeof form !== 'object' || form === null) return false;
  const f = form as Record<string, unknown>;
  return typeof f['host'] === 'string' && typeof f['model'] === 'string' && typeof f['tls'] === 'boolean';
}

/**
 * One Connect press: the form, as the argv the user would have typed, through the real parser.
 *
 * A `UsageError` -- an empty host's `MissingHostError` included -- is an ANSWER, shown in the
 * dialog, which stays open. Anything else is rethrown: it is a bug, and main's handler turning it
 * into a rejected `invoke` is the visible failure it deserves.
 *
 * THE MODEL IS CHECKED HERE TOO, by core's own `resolveTerminalType`, because `parseGuiArgs` takes
 * any string for `-model` and leaves it to `buildSession` -- whose failure is a SETUP failure, shown
 * in the terminal window after the dialog has gone, with no dialog left to fix it in (main.ts,
 * `openConnectDialog`). The dropdown offers only known models, so this is reached only by a page
 * that sent something it never listed.
 */
export function submitConnect(
  form: unknown,
  commandLine: readonly string[],
  parse: (argv: readonly string[]) => GuiArgs = parseGuiArgs,
): SubmitResult {
  if (!isConnectForm(form)) {
    return { ok: false, error: `malformed connect form ${JSON.stringify(form) ?? String(form)}` };
  }
  try {
    resolveTerminalType({ model: form.model });
    return { ok: true, args: parse(dialogToArgv(form, commandLine)) };
  } catch (err) {
    if (err instanceof UsageError || err instanceof TerminalTypeError) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * `TN3270_GUI_CONNECT`, the dialog's test seam: a LIST of `{"host": ..., "model": ..., "tls": ...}`
 * forms, one per press of Connect, which main types into the dialog's own controls in turn -- a
 * failed attempt leaves the dialog open for the next (spec 2026-11-08-connect-dialog-retry-design).
 * A single form is a list of one. EMPTY MEANS ABSENT, as for every seam in main.ts.
 *
 * Refused by name when malformed, rather than driving a half-filled form: a typo would otherwise
 * read as a dialog that ignores its input. An empty list is malformed too: it would open a dialog
 * nobody answers, which under a harness is a hang.
 */
export function parseConnectSeam(raw: string): readonly ConnectForm[] | undefined {
  if (raw === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = undefined;
  }
  const forms: readonly unknown[] | undefined = isConnectForm(value) ? [value]
    : Array.isArray(value) && value.length > 0 ? value : undefined;
  if (forms === undefined || !forms.every(isConnectForm)) {
    throw new Error('TN3270_GUI_CONNECT must be JSON {"host": string, "model": string, "tls": boolean} '
      + `or a non-empty list of them, not ${JSON.stringify(raw)}`);
  }
  return forms.map((f) => ({ host: f.host, model: f.model, tls: f.tls }));
}
