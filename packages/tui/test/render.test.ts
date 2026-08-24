import { describe, expect, it } from 'vitest';
import { Colour, type ResolvedCell } from '@tn3270/core';
import { TerminalRenderer, tooSmall } from '../src/render.js';

/** A 2x3 grid of plain green cells, with `text` from a string. */
function grid(text: string, rows = 2, cols = 3): ResolvedCell[] {
  return [...text].map((ch) => ({
    text: ch, fg: Colour.GREEN, bg: Colour.NEUTRAL_BLACK,
    blink: false, reverse: false, underscore: false, intensify: false, hidden: false,
  })).slice(0, rows * cols);
}

describe('tooSmall', () => {
  it('rejects a terminal narrower or shorter than the screen plus a status row', () => {
    expect(tooSmall({ rows: 24, cols: 80 }, { rows: 24, cols: 80 })).toBe(true);  // no room for OIA
    expect(tooSmall({ rows: 25, cols: 80 }, { rows: 24, cols: 80 })).toBe(false);
    expect(tooSmall({ rows: 25, cols: 79 }, { rows: 24, cols: 80 })).toBe(true);
    expect(tooSmall({ rows: 30, cols: 132 }, { rows: 27, cols: 132 })).toBe(false);
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
