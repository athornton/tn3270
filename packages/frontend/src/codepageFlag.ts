import { resolveCodePage, CODE_PAGE_NAMES, type CodePage } from '@tn3270/core';

/**
 * `-codepage NAME` / `-charset NAME` (x3270.c:156, :159), shared by every front end. The error
 * factory is injected because each front end has its own `UsageError`, as `takeTlsFlag` does.
 * The message puts the remedy first, so a truncated line still says what to type.
 */
export function codePageFlag(
  flag: string, value: string | undefined, usageError: (m: string) => Error,
): CodePage {
  if (value === undefined) throw usageError(`${flag} needs a value: ${CODE_PAGE_NAMES.join(', ')}`);
  try {
    return resolveCodePage(value);
  } catch (e) {
    throw usageError(`${flag}: ${(e as Error).message}`);
  }
}
