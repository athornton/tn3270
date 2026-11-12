import { describe, it, expect } from 'vitest';
import { cp037, FA, Screen } from '@tn3270/core';

import {
  NON_START_ROWS_SHOWN, describeNonStart, screenRows, type NonStart,
} from '../src/transferStart.js';

/**
 * The text both transfer drivers report when a transfer NEVER STARTED: no CUT frame and nothing
 * from DFT before the start deadline.
 *
 * Owner's decision 2026-11-12 (option A): x3270's own wording, `ftStartTimeout` "Transfer did not
 * start within 30s" (suite3270-4.5 `fb-common:34`, fired by `ft_didnt_start`, `ft.c:488-501`),
 * instead of "host may still be transferring" -- which is false when nothing ever started -- plus
 * the host's OWN WORDS: the rows it changed after the command was sent.
 *
 * x3270 reads nothing off the screen here (no `RC=`/`READY`/`Ready` scan in `ft.c`, `ft_cut.c` or
 * `ft_dft.c`), so quoting the screen is ours. It still waits out the deadline, as x3270 does;
 * ending early needs a captured TSO refusal screen that does not exist yet.
 */

/** A 24x80 screen of blank rows, with the given 1-based rows set to text. */
function rows(set: Record<number, string>, count = 24): string[] {
  const out = new Array<string>(count).fill(' '.repeat(80));
  for (const [r, text] of Object.entries(set)) out[Number(r) - 1] = text.padEnd(80, ' ');
  return out;
}

const base: Omit<NonStart, 'before' | 'after'> = {
  seconds: 30, keyboardLocked: false, sawHostWrite: true, ddmAdvertised: true, rows: 24, cols: 80,
};

describe('describeNonStart', () => {
  it("QUOTES MECAFF'S REFUSAL VERBATIM, and says x3270's words, not 'may still be transferring'", () => {
    // PROVENANCE: `docs/live-testing.md:757-759`, VM/370 CMS, 2026-09-25. MECAFF answered
    // "Error: IND$FILE requires a MECAFF connected 3270 terminal", then "... aborting", and CMS
    // returned to "Ready(00032)" by itself -- zero CUT frames, zero 0xd0 frames. The rows are
    // the live text; their screen positions are ours (the run kept the lines, not a trace).
    const before = rows({ 24: 'IND$FILE PUT FORM TEST A' });
    const after = rows({
      1: 'Error: IND$FILE requires a MECAFF connected 3270 terminal',
      2: '... aborting',
      3: 'Ready(00032)',
    });
    expect(describeNonStart({ ...base, before, after })).toBe(
      'transfer did not start within 30s (we offered CUT or DFT); the host wrote: '
        + '"Error: IND$FILE requires a MECAFF connected 3270 terminal" / "... aborting" / "Ready(00032)"',
    );
  });

  it('a TSO host that only answered READY: the stale READY above is NOT quoted, the new one is', () => {
    // TSO's prompt is `READY` (live-testing.md:4228: FFTP "prints nothing at all -- straight back
    // to READY"). TSO line mode leaves the PREVIOUS `READY` on screen, which is exactly the stale
    // line a screen scrape must not read: only rows that CHANGED are the host's answer.
    const before = rows({ 1: 'READY', 2: "IND$FILE GET 'HERC01.A.BIN'" });
    const after = rows({ 1: 'READY', 2: "IND$FILE GET 'HERC01.A.BIN'", 3: 'READY' });
    const text = describeNonStart({ ...base, before, after });
    expect(text).toBe('transfer did not start within 30s (we offered CUT or DFT); the host wrote: "READY"');
    expect(text).not.toMatch(/may still|transfer mode/);
  });

  it('says the host wrote nothing, and keeps Attn/Clear first while the keyboard is still locked', () => {
    // No host write since Enter means the keyboard is still in X SYSTEM: the host may still be
    // working on the command, so interrupting it is still the right advice -- and it leads,
    // because the TUI's status line is 54 columns and truncates.
    const before = rows({ 1: 'READY', 2: 'IND$FILE GET X' });
    expect(describeNonStart({
      ...base, before, after: before, keyboardLocked: true, sawHostWrite: false,
    })).toBe('press Attn or Clear: transfer did not start within 30s (we offered CUT or DFT); '
      + 'the host wrote nothing');
  });

  it('a host that wrote without changing any text is not called silent', () => {
    const before = rows({ 1: 'READY' });
    expect(describeNonStart({ ...base, before, after: before }))
      .toBe('transfer did not start within 30s (we offered CUT or DFT); the screen did not change');
  });

  it(`shows at most ${NON_START_ROWS_SHOWN} rows, in screen order, and counts the rest`, () => {
    const after = rows(Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [i + 1, `  LINE ${i + 1}  `]),
    ));
    // Blank rows that changed (a cleared input line) are dropped, and do not count as omitted.
    const before = rows({ 24: 'IND$FILE GET X' });
    const text = describeNonStart({ ...base, before, after });
    expect(NON_START_ROWS_SHOWN).toBeGreaterThanOrEqual(3);   // MECAFF's refusal is 3 rows
    const shown = Array.from({ length: NON_START_ROWS_SHOWN }, (_, i) => `"LINE ${i + 1}"`).join(' / ');
    expect(text).toBe(`transfer did not start within 30s (we offered CUT or DFT); the host wrote: ${shown}`
      + ` (${8 - NON_START_ROWS_SHOWN} more rows omitted)`);
  });

  it('takes the number from the deadline it is given, and the DDM and geometry hints still apply', () => {
    const quiet = rows({ 1: 'READY' });
    expect(describeNonStart({
      ...base, seconds: 0.1, before: quiet, after: quiet, sawHostWrite: false, ddmAdvertised: false,
      rows: 43, cols: 80,
    })).toBe('transfer did not start within 0.1s (we offered CUT only); the host wrote nothing'
      + ' (DDM was not advertised; a host that speaks only DFT needs -ddm on)'
      + ' (a CUT host needs 24x80; this session is 43x80)');
  });

  it('treats every row as changed when the geometry changed under it', () => {
    const before = rows({ 1: 'READY' });
    const after = rows({ 1: 'READY' }, 43);
    expect(describeNonStart({ ...base, before, after, rows: 43 }))
      .toBe('transfer did not start within 30s (we offered CUT or DFT); the host wrote: "READY"'
        + ' (a CUT host needs 24x80; this session is 43x80)');
  });
});

describe('screenRows', () => {
  it('reads each row, and blanks a non-display field rather than quoting it', () => {
    const s = new Screen({ rows: 24, cols: 80 });
    const put = (addr: number, text: string): void => {
      for (let i = 0; i < text.length; i++) s.setChar(addr + i, cp037.fromUnicode(text[i]!));
    };
    put(0, 'READY');
    s.setFieldAttribute(80, FA.INT_ZERO_NSEL);   // row 2: a hidden field, e.g. a password
    put(81, 'SECRET');
    s.setFieldAttribute(160, 0x00);
    put(161, 'SHOWN');
    const got = screenRows(s);
    expect(got).toHaveLength(24);
    expect(got[0]!.trim()).toBe('READY');
    expect(got[1]!.trim()).toBe('');
    expect(got[2]!.trim()).toBe('SHOWN');
  });
});
