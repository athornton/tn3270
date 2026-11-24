import { basename } from 'node:path';
import type { GeometrySetting } from '@tn3270/core';
import { argvToPrefs, loadPrefs, oversizeFlagValue, GUI_PREF_KEYS, type PrefsFs } from '@tn3270/frontend';
import { MissingHostError, parseGuiArgs, UsageError, type GuiArgs } from './args.js';

/**
 * `parseGuiArgs` for an argv that may have no host (a preferences file never has one; a dialog
 * launch has none): a `MissingHostError` alone is retried with a placeholder host, so every flag
 * is still checked. Any other error is the argv's own.
 */
function parseHostless(argv: readonly string[]): GuiArgs {
  try {
    return parseGuiArgs(argv);
  } catch (e) {
    if (!(e instanceof MissingHostError)) throw e;
    return parseGuiArgs([...argv, 'placeholder.invalid']);
  }
}

/**
 * The GUI's startup argv: `preferences.json`'s tokens, then the typed ones (defaults < file <
 * flags; spec 2026-11-24-preferences-store-design.md). The file's tokens are parsed ON THEIR OWN
 * first, so a bad value is reported against the file. Warnings go to `warn`.
 */
export function guiEffectiveArgv(
  typed: readonly string[], path: string, fs: PrefsFs, warn: (w: string) => void,
): string[] {
  let loaded;
  try {
    loaded = loadPrefs(path, GUI_PREF_KEYS, fs);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  for (const w of loaded.warnings) warn(w);
  try {
    parseHostless(loaded.argv);
  } catch (e) {
    throw new UsageError(`${basename(path)}: ${(e as Error).message}`);
  }
  return [...loaded.argv, ...typed];
}

/**
 * What File -> Save Changed Options writes: the stored settings the startup argv sets (file and
 * flags), then the Model and Oversize menus' current choice, which `geometrySetting` holds.
 */
export function guiPrefsToSave(
  startupArgv: readonly string[], geometry: GeometrySetting | undefined,
): Record<string, unknown> {
  const prefs = argvToPrefs(startupArgv, GUI_PREF_KEYS);
  if (geometry !== undefined) {
    if (geometry.model !== undefined) prefs['model'] = geometry.model;
    prefs['oversize'] = oversizeFlagValue(geometry.oversize);
    if (prefs['oversize'] === 'none' && !('oversize' in argvToPrefs(startupArgv, GUI_PREF_KEYS))) {
      delete prefs['oversize'];   // still the built-in default, and never set: leave it out
    }
  }
  return prefs;
}

/** The model the startup argv names, for the Connect dialog's default; undefined if none or unparseable. */
export function startupModel(argv: readonly string[]): string | undefined {
  try {
    return parseHostless(argv).model;
  } catch {
    return undefined;   // the dialog's own submit reports a bad command line
  }
}
