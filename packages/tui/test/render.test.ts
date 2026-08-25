import { describe, expect, it } from 'vitest';
import { Colour, type ResolvedCell } from '@tn3270/core';
import { layout, statusRowFor, TerminalRenderer, tooSmall, type Layout } from '../src/render.js';

/** A 2x3 grid of plain green cells, with `text` from a string. */
function grid(text: string, rows = 2, cols = 3): ResolvedCell[] {
  return [...text].map((ch) => ({
    text: ch, fg: Colour.GREEN, bg: Colour.NEUTRAL_BLACK,
    blink: false, reverse: false, underscore: false, intensify: false, hidden: false,
  })).slice(0, rows * cols);
}

describe('tooSmall', () => {
  // ⚠️ THE 3270 SCREEN IS MANDATORY; THE OIA IS NOT. This deliberately matches
  // c3270, which errors only when the SCREEN will not fit ("Rows and/or cols too
  // small on default screen (minimum 24x80)", c3270/screen.c:412-419) and simply
  // drops the status line when there is no room for it (`set_status_row`,
  // screen.c:895: `if (screen_rows < emulator_rows + 1) { status_row = 0; }`).
  //
  // An earlier version of this required screen.rows + 1 and refused below it, which
  // made us STRICTER THAN THE REFERENCE and rejected an 80x24 terminal -- the
  // commonest size there is -- for no protocol reason. The OIA is our own chrome;
  // the 1920 cells are the host's data, and only the latter is worth refusing over.
  it('accepts a terminal that fits the screen exactly, with no room for the OIA', () => {
    expect(tooSmall({ rows: 24, cols: 80 }, { rows: 24, cols: 80 })).toBe(false);
  });

  it('rejects a terminal that cannot hold the screen itself', () => {
    expect(tooSmall({ rows: 23, cols: 80 }, { rows: 24, cols: 80 })).toBe(true);
    expect(tooSmall({ rows: 24, cols: 79 }, { rows: 24, cols: 80 })).toBe(true);
    expect(tooSmall({ rows: 26, cols: 131 }, { rows: 27, cols: 132 })).toBe(true);
  });

  it('accepts anything larger', () => {
    expect(tooSmall({ rows: 25, cols: 80 }, { rows: 24, cols: 80 })).toBe(false);
    expect(tooSmall({ rows: 30, cols: 132 }, { rows: 27, cols: 132 })).toBe(false);
  });
});

describe('statusRowFor', () => {
  it('gives the row below the screen when there is room', () => {
    expect(statusRowFor({ rows: 25, cols: 80 }, { rows: 24, cols: 80 })).toBe(25);
    expect(statusRowFor({ rows: 40, cols: 80 }, { rows: 24, cols: 80 })).toBe(25);
  });

  it('gives undefined when the OIA does not fit, rather than a row off the bottom', () => {
    // The whole point of the relaxed minimum: at exactly screen.rows the client
    // still runs, and the status line is DROPPED rather than drawn where the
    // terminal would scroll it -- which would push the 3270 screen up a line and
    // corrupt every subsequent cursor address.
    expect(statusRowFor({ rows: 24, cols: 80 }, { rows: 24, cols: 80 })).toBeUndefined();
  });

  it('pins itself against tooSmall, since they are one decision', () => {
    // Any terminal tooSmall accepts must either have a status row or knowingly
    // have none; neither may be a row the terminal does not contain.
    const screen = { rows: 24, cols: 80 };
    for (const rows of [24, 25, 26, 50]) {
      const term = { rows, cols: 80 };
      expect(tooSmall(term, screen), `rows ${rows}`).toBe(false);
      const sr = statusRowFor(term, screen);
      if (sr !== undefined) expect(sr, `rows ${rows}`).toBeLessThanOrEqual(rows);
    }
  });
});

describe('layout: centring, and which border sides fit', () => {
  const S = { rows: 24, cols: 80 };

  it('exactly fits: no border, no status, no offset', () => {
    expect(layout({ rows: 24, cols: 80 }, S)).toEqual({
      rowOffset: 0, colOffset: 0, statusRow: undefined,
      border: { top: false, bottom: false, left: false, right: false },
    });
  });

  it('one spare row goes to the STATUS LINE, not a border', () => {
    // The judgment call, stated so it can be flipped: the OIA is functional and
    // the border is decorative, so with a single spare row the OIA wins.
    const l = layout({ rows: 25, cols: 80 }, S);
    expect(l.statusRow).toBe(25);
    expect(l.border.bottom).toBe(false);
    expect(l.rowOffset).toBe(0);
  });

  it('two spare rows add the BOTTOM border before the top', () => {
    const l = layout({ rows: 26, cols: 80 }, S);
    expect(l.border).toEqual({ top: false, bottom: true, left: false, right: false });
  });

  it('three spare rows add the top border too', () => {
    const l = layout({ rows: 27, cols: 80 }, S);
    expect(l.border.top).toBe(true);
    expect(l.border.bottom).toBe(true);
  });

  it('one spare column goes to the LEFT border, not the right', () => {
    const l = layout({ rows: 24, cols: 81 }, S);
    expect(l.border).toEqual({ top: false, bottom: false, left: true, right: false });
    expect(l.colOffset).toBe(1);          // the screen sits right of the border
  });

  it('two spare columns add the right border', () => {
    const l = layout({ rows: 24, cols: 82 }, S);
    expect(l.border.left).toBe(true);
    expect(l.border.right).toBe(true);
    expect(l.colOffset).toBe(1);
  });

  it('centres the whole block in a roomy terminal', () => {
    // 40 rows: block is top+24+status+bottom = 27, so 13 spare -> 6 above.
    // 100 cols: block is 1+80+1 = 82, so 18 spare -> 9 left of the border.
    const l = layout({ rows: 40, cols: 100 }, S);
    expect(l.rowOffset).toBe(6 + 1);      // +1 for the top border row
    expect(l.colOffset).toBe(9 + 1);      // +1 for the left border column
    expect(l.statusRow).toBe(l.rowOffset + S.rows + 1);
    expect(l.border).toEqual({ top: true, bottom: true, left: true, right: true });
  });

  it('never places anything outside the terminal', () => {
    // The invariant that matters: a border row below the terminal, or a status row
    // past the last line, scrolls the window and corrupts every later address.
    for (let rows = 24; rows <= 45; rows++) {
      for (const cols of [80, 81, 82, 100, 132]) {
        const t = { rows, cols };
        const l = layout(t, S);
        const bottomMost = l.rowOffset + S.rows
          + (l.statusRow !== undefined ? 1 : 0) + (l.border.bottom ? 1 : 0);
        expect(bottomMost, `${cols}x${rows}`).toBeLessThanOrEqual(rows);
        expect(l.rowOffset - (l.border.top ? 1 : 0), `${cols}x${rows}`).toBeGreaterThanOrEqual(0);
        const rightMost = l.colOffset + S.cols + (l.border.right ? 1 : 0);
        expect(rightMost, `${cols}x${rows}`).toBeLessThanOrEqual(cols);
        expect(l.colOffset - (l.border.left ? 1 : 0), `${cols}x${rows}`).toBeGreaterThanOrEqual(0);
        if (l.statusRow !== undefined) expect(l.statusRow).toBeLessThanOrEqual(rows);
      }
    }
  });
});

describe('TerminalRenderer', () => {
  it('emits the text of every cell on the first paint', () => {
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0 });
    const out = r.paint(grid('ABCDEF'), 0, 'status');
    expect(out).toContain('ABC');
    expect(out).toContain('DEF');
  });

  it('emits nothing for an unchanged repaint', () => {
    // The whole point of diffing: a host that rewrites an identical screen must
    // not make the terminal flicker.
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0 });
    const cells = grid('ABCDEF');
    r.paint(cells, 0, 'status');
    const second = r.paint(cells, 0, 'status');
    expect(second).toBe('');
  });

  it('emits only the changed cell on a small change', () => {
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0 });
    r.paint(grid('ABCDEF'), 0, 'status');
    const out = r.paint(grid('ABCDEX'), 0, 'status');
    expect(out).toContain('X');
    expect(out).not.toContain('ABC');
  });

  it('repaints when the cursor moves, even with identical cells', () => {
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0 });
    const cells = grid('ABCDEF');
    r.paint(cells, 0, 'status');
    expect(r.paint(cells, 4, 'status')).not.toBe('');
  });

  it('repaints when the status line changes', () => {
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0 });
    const cells = grid('ABCDEF');
    r.paint(cells, 0, 'X Wait');
    expect(r.paint(cells, 0, 'ok')).toContain('ok');
  });

  it('draws the status line on the row immediately below the screen', () => {
    // Found by mutation: moving the status to `rows + 2` left all eleven other
    // tests green, yet it is a visible bug. `tooSmall` reserves exactly ONE
    // extra row, so a status line one row lower is drawn off the bottom of a
    // terminal this renderer just declared big enough. The row number and
    // tooSmall's allowance are one decision and must be pinned together.
    for (const rows of [2, 24, 27]) {
      const r = new TerminalRenderer({ rows, cols: 3, depth: 0 });
      const out = r.paint(grid('ABCDEF', rows), 0, 'MYSTATUS');
      expect(out).toContain(`\x1b[${rows + 1};1H`);
      expect(out).not.toContain(`\x1b[${rows + 2};1H`);
      // And the smallest terminal tooSmall accepts must actually contain it.
      expect(tooSmall({ rows: rows + 1, cols: 3 }, { rows, cols: 3 })).toBe(false);
    }
  });

  it('draws NO status line when told there is no room for one', () => {
    // The 80x24 case. The screen must still be drawn in full; only the OIA goes.
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0, layout: { rowOffset: 0, colOffset: 0, statusRow: undefined, border: { top: false, bottom: false, left: false, right: false } } });
    const out = r.paint(grid('ABCDEF'), 0, 'MYSTATUS');
    expect(out).toContain('ABC');
    expect(out).toContain('DEF');
    expect(out).not.toContain('MYSTATUS');
    expect(out).not.toContain('\x1b[3;1H');   // no write to the row below the screen
  });

  it('still emits nothing for an unchanged repaint with no status line', () => {
    // The status line is what forces a write when it changes; with none, an
    // unchanged screen must still produce zero bytes rather than falling back to a
    // full repaint every time.
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0, layout: { rowOffset: 0, colOffset: 0, statusRow: undefined, border: { top: false, bottom: false, left: false, right: false } } });
    const cells = grid('ABCDEF');
    r.paint(cells, 0, 'one');
    expect(r.paint(cells, 0, 'two')).toBe('');   // status changed, but there is nowhere to put it
  });

  it('starts and stops drawing the status line when told the room changed', () => {
    // What a terminal resize does. Growing must produce the OIA; shrinking must
    // stop producing it, and each transition repaints in full because every cursor
    // address the diff remembers was computed for the old layout.
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0, layout: { rowOffset: 0, colOffset: 0, statusRow: undefined, border: { top: false, bottom: false, left: false, right: false } } });
    const cells = grid('ABCDEF');
    r.paint(cells, 0, 'ok');
    r.setLayout({ rowOffset: 0, colOffset: 0, statusRow: 3, border: { top: false, bottom: false, left: false, right: false } });
    const grown = r.paint(cells, 0, 'ok');
    // 'ok' not 'HELLO': the status is TRUNCATED to the screen width, so a 5-character
    // status cannot appear in full on a 3-column screen. Truncation is deliberate --
    // overrunning the width would overwrite the right-hand border.
    expect(grown).toContain('ok');
    expect(grown).toContain('ABC');             // full repaint, not just the status
    r.setLayout({ rowOffset: 0, colOffset: 0, statusRow: undefined, border: { top: false, bottom: false, left: false, right: false } });
    const shrunk = r.paint(cells, 0, 'ok');
    expect(shrunk).not.toContain('ok');
    expect(shrunk).toContain('ABC');
  });

  it('emits no colour escapes at all when monochrome', () => {
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0 });
    const cells = grid('ABCDEF');
    cells[0]!.fg = Colour.RED;
    const out = r.paint(cells, 0, 'status');
    expect(out).not.toMatch(/\x1b\[3[0-9]/);
    expect(out).not.toMatch(/\x1b\[38;/);
  });

  // ⚠️ THE FOREGROUND PARAMETER IS NOT THE WHOLE SGR, so it is not followed by
  // `m`. A cell emits fg AND bg in ONE sequence -- `\x1b[38;5;46;48;5;59m` --
  // which is the point of `cellSgr`. The obvious `/\x1b\[38;5;\d+m/` therefore
  // matches NOTHING, and two tests below were originally written that way: one
  // failed honestly, and the other silently passed while counting zero. That
  // second one was verified vacuous by mutation -- an implementation emitting a
  // fresh SGR for every cell, the exact defect it names, still passed it. Match
  // the parameter WITHIN the list.
  const FG_256 = /\x1b\[[\d;]*38;5;\d+[\d;]*m/;
  const FG_256_ALL = /\x1b\[[\d;]*38;5;\d+[\d;]*m/g;

  it('emits a colour escape when the colour changes mid-row', () => {
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 256 });
    const cells = grid('ABCDEF');
    cells[1]!.fg = Colour.RED;
    const out = r.paint(cells, 0, 'status');
    expect(out).toMatch(FG_256);
    // Green, then red for the one changed cell, then green again: the run-length
    // logic must break and re-establish, so exactly three.
    expect(out.match(FG_256_ALL) ?? []).toHaveLength(3);
  });

  it('does not repeat an identical SGR for adjacent cells', () => {
    // Six cells of one colour must not produce six escape sequences; that
    // triples the bytes written on every redraw over a slow link.
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 256 });
    const out = r.paint(grid('ABCDEF'), 0, 'status');
    const escapes = out.match(FG_256_ALL) ?? [];
    // EXACTLY one, not "at most one per row": the cells are contiguous, so a
    // single SGR covers the whole uniform paint and the run survives the row
    // boundary. An upper bound of 2 would still pass the one-SGR-per-cell
    // mutant if the regex were ever loosened back; an exact count cannot.
    expect(escapes).toHaveLength(1);
  });

  it('renders a hidden cell as blank without emitting its text', () => {
    // A password field must not be readable from the terminal scrollback.
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0 });
    const cells = grid('ABCDEF');
    cells[0]!.hidden = true;
    const out = r.paint(cells, 0, 'status');
    expect(out).not.toContain('A');
  });

  it('TURNS REVERSE OFF AGAIN once the highlighted run ends', () => {
    // THE MOTTLING BUG. SGR parameters ACCUMULATE: emitting `\x1b[38;5;46;48;5;59m`
    // sets colours but leaves SGR 7 in effect, because only 0 or 27 clears it. So a
    // reverse-video run -- ISPF's tutorial title bar sends SA highlighting=0xF2 for
    // exactly one -- left every following cell inverted, turning each subsequent
    // SPACE into a solid green block and giving the page a mottled look. VM never
    // sends reverse, which is why only TK5 showed it.
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 256 });
    const cells = grid('ABCDEF');
    cells[0]!.reverse = true;              // one highlighted cell, then plain ones
    const out = r.paint(cells, 0, 's');
    // The SGR that precedes 'B' is the one that must undo the reverse.
    const between = out.slice(out.indexOf('A') + 1, out.indexOf('B'));
    expect(between, `emitted ${JSON.stringify(between)}`).toMatch(/(^|[;[])(0|27)([;m])/);
  });

  it('clears highlighting between runs for every flag, at every depth', () => {
    // The general form, so the same class of bug cannot come back via a different
    // attribute. At depth 0 the `want || '0'` fallback already emitted a reset, which
    // is why the monochrome case hid this for so long -- test the colour depths too.
    for (const depth of [0, 16, 256] as const) {
      for (const flag of ['reverse', 'blink', 'underscore', 'intensify'] as const) {
        const r = new TerminalRenderer({ rows: 2, cols: 3, depth });
        const cells = grid('ABCDEF');
        cells[0]![flag] = true;
        const out = r.paint(cells, 0, 's');
        const between = out.slice(out.indexOf('A') + 1, out.indexOf('B'));
        expect(between, `${flag} at depth ${depth}: ${JSON.stringify(between)}`)
          .toMatch(/(^|[;[])(0|2[2457])([;m])/);
      }
    }
  });

  it('emits the highlighting attributes it supports', () => {
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 256 });
    const cells = grid('ABCDEF');
    cells[0]!.underscore = true;
    cells[1]!.reverse = true;
    cells[2]!.blink = true;
    const out = r.paint(cells, 0, 'status');
    expect(out).toContain('4');   // SGR 4 underline
    expect(out).toContain('7');   // SGR 7 reverse
    expect(out).toContain('5');   // SGR 5 blink
  });
});

describe('TerminalRenderer placement: offsets and border', () => {
  const NONE = { top: false, bottom: false, left: false, right: false };
  const lay = (over: Partial<Layout> = {}): Layout => ({
    rowOffset: 0, colOffset: 0, statusRow: 3, border: NONE, ...over,
  });

  it('offsets every cell write by the layout', () => {
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0, layout: lay({ rowOffset: 5, colOffset: 10 }) });
    const out = r.paint(grid('ABCDEF'), 0, 's');
    expect(out).toContain('\x1b[6;11H');      // screen cell 0 -> terminal row 6, col 11
    expect(out).not.toContain('\x1b[1;1H');
  });

  it('offsets the second row correctly, not just the first', () => {
    // The bug a single-cell test would miss: an offset applied to the row but not
    // recomputed per row, or added to the address rather than to row/col.
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0, layout: lay({ rowOffset: 5, colOffset: 10 }) });
    r.paint(grid('ABCDEF'), 0, 's');
    const out = r.paint(grid('ABCDEX'), 0, 's');   // only cell 5 changed: row 2, col 3
    expect(out).toContain('\x1b[7;13H');
  });

  it('starts EVERY screen row with its own position escape when offset', () => {
    // THE BUG THIS EXISTS FOR: cells are contiguous across a row boundary, so the
    // run-length logic emitted no escape there and relied on the TERMINAL wrapping
    // at the screen's right edge. That is only true when the screen exactly fills
    // the terminal width. Centred in a 90-column window, an 80-column screen wrapped
    // at column 90 instead of 85, so every row after the first was misplaced --
    // caught by looking at a real 90x30 pty, where only rows 3 and 27 began at the
    // screen's left edge.
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0, layout: lay({ rowOffset: 5, colOffset: 10 }) });
    const out = r.paint(grid('ABCDEF'), 0, 's');
    expect(out).toContain('\x1b[6;11H');   // row 1 of the screen
    expect(out).toContain('\x1b[7;11H');   // row 2 must be positioned too
  });

  it('offsets the cursor', () => {
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0, layout: lay({ rowOffset: 5, colOffset: 10 }) });
    const out = r.paint(grid('ABCDEF'), 4, 's');
    expect(out.endsWith('\x1b[7;12H')).toBe(true);   // cell 4 = row 2, col 2
  });

  it('aligns the status line with the screen, not with column 1', () => {
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0, layout: lay({ rowOffset: 5, colOffset: 10, statusRow: 9 }) });
    const out = r.paint(grid('ABCDEF'), 0, 'ok');
    expect(out).toContain('\x1b[9;11H\x1b[0mok');
  });

  it('pads the status line to the screen width instead of erasing to end of line', () => {
    // With a right-hand border, `\x1b[K` would erase it on the status row. Padding
    // to exactly the screen width clears the old text without touching the border.
    const r = new TerminalRenderer({ rows: 2, cols: 6, depth: 0, layout: lay({ statusRow: 3 }) });
    const out = r.paint(grid('ABCDEF', 1, 6), 0, 'ok');
    expect(out).toContain('ok    ');           // padded to 6
    expect(out).not.toContain('\x1b[K');
  });

  it('draws a full border on the first paint', () => {
    const r = new TerminalRenderer({
      rows: 2, cols: 3, depth: 0,
      layout: lay({ rowOffset: 2, colOffset: 2, statusRow: 4, border: { top: true, bottom: true, left: true, right: true } }),
    });
    const out = r.paint(grid('ABCDEF'), 0, 's');
    expect(out).toContain('┌───┐');            // top: corners plus screen width
    expect(out).toContain('└───┘');
    expect(out).toContain('│');
  });

  it('draws only the sides the layout allows', () => {
    const r = new TerminalRenderer({
      rows: 2, cols: 3, depth: 0,
      layout: lay({ colOffset: 1, border: { top: false, bottom: true, left: true, right: false } }),
    });
    const out = r.paint(grid('ABCDEF'), 0, 's');
    expect(out).toContain('│');
    expect(out).toContain('─');
    expect(out).not.toContain('┌');            // no top border, so no top corners
    expect(out).not.toContain('┐');
    expect(out).not.toContain('┘');            // no right side, so no right corner
  });

  it('does NOT redraw the border on an incremental repaint', () => {
    // It would be a lot of bytes per keystroke, and the border never changes.
    const r = new TerminalRenderer({
      rows: 2, cols: 3, depth: 0,
      layout: lay({ rowOffset: 2, colOffset: 2, border: { top: true, bottom: true, left: true, right: true } }),
    });
    r.paint(grid('ABCDEF'), 0, 's');
    const out = r.paint(grid('ABCDEX'), 0, 's');
    expect(out).toContain('X');
    expect(out).not.toContain('─');
    expect(out).not.toContain('│');
  });

  it('redraws the border after setLayout, and clears the old position', () => {
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0, layout: lay() });
    r.paint(grid('ABCDEF'), 0, 's');
    const moved = r.paint.bind(r);
    r.setLayout(lay({ rowOffset: 4, colOffset: 4, border: { top: true, bottom: true, left: true, right: true } }));
    const out = moved(grid('ABCDEF'), 0, 's');
    expect(out).toContain('\x1b[2J');          // old drawing must not be left behind
    expect(out).toContain('┌───┐');
    expect(out).toContain('ABC');              // and a full repaint follows
  });

  it('does not clear or invalidate when setLayout is given the same layout', () => {
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0, layout: lay() });
    const cells = grid('ABCDEF');
    r.paint(cells, 0, 's');
    r.setLayout(lay());
    expect(r.paint(cells, 0, 's')).toBe('');
  });
});
