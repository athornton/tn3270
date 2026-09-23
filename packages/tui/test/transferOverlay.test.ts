import { describe, it, expect } from 'vitest';
import { newTransferForm, cycleField, setFieldText } from '@tn3270/frontend';
import { transferLines, transferFits, TRANSFER_MIN } from '../src/transferOverlay.js';

describe('TRANSFER_MIN', () => {
  it('is at most 24x80, so it never refuses a terminal the session accepted', () => {
    // `tooSmall` (render.ts) already demands 24x80 before a session runs, and the
    // smallest 3270 screen IS 24x80. A minimum above that would be a refusal an
    // operator could provoke on a terminal the session itself was happy with.
    expect(TRANSFER_MIN.rows).toBeLessThanOrEqual(24);
    expect(TRANSFER_MIN.cols).toBeLessThanOrEqual(80);
  });

  it('is tall enough for every line the form can draw', () => {
    // Recomputed here rather than derived in the module, so the two can DISAGREE --
    // deriving it would make it correct by construction and unable to catch a change.
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);      // send: the most fields
    s = cycleField(s, 'recfm', 1);          // reveals Lrecl and Blksize
    s = cycleField(s, 'mode', 1);           // ascii: reveals Cr
    expect(transferLines(s, 'idle', undefined).length).toBeLessThanOrEqual(TRANSFER_MIN.rows);
  });
});

describe('transferFits', () => {
  it('accepts a terminal at the minimum and refuses one below it', () => {
    expect(transferFits({ rows: TRANSFER_MIN.rows, cols: TRANSFER_MIN.cols })).toBe(true);
    expect(transferFits({ rows: TRANSFER_MIN.rows - 1, cols: TRANSFER_MIN.cols })).toBe(false);
    expect(transferFits({ rows: TRANSFER_MIN.rows, cols: TRANSFER_MIN.cols - 1 })).toBe(false);
  });
});

describe('transferLines', () => {
  it('marks the selected field and no other', () => {
    const s = newTransferForm();
    const lines = transferLines(s, 'idle', undefined);
    expect(lines.filter((l) => l.startsWith('>'))).toHaveLength(1);
    expect(lines.find((l) => l.startsWith('>'))).toContain('Direction');
  });

  it('is OPAQUE: every line is the same width', () => {
    // The keypad overlay learned this the hard way -- a trimEnd() let host text through
    // into the chord column, inventing a chord for 22 keys that have none. Here the leak
    // would put host cells where a field value goes, which reads as a value the user did
    // not type.
    const s = newTransferForm();
    const lines = transferLines(s, 'idle', undefined);
    const widths = new Set(lines.map((l) => l.length));
    expect(widths.size).toBe(1);
  });

  it('stays opaque in EVERY phase and with an error, not just idle', () => {
    // NOT IN THE PLAN, and it is the case that matters: the status line is the ONLY
    // variable-length line, so if padding or truncation is wrong anywhere it is there --
    // and `idle` alone exercises one of its five branches.
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);
    s = cycleField(s, 'mode', 1);
    const states = [
      transferLines(s, 'idle', undefined),
      transferLines(s, 'running', '512 bytes'),
      transferLines(s, 'done', '4096 bytes transferred'),
      transferLines(s, 'failed', 'Transfer canceled by user'),
      transferLines({ ...s, error: 'x'.repeat(300) }, 'idle', undefined),
      transferLines({ ...s, error: 'short' }, 'idle', undefined),
    ];
    for (const lines of states) expect(new Set(lines.map((l) => l.length)).size).toBe(1);
  });

  it('omits an inapplicable field entirely rather than drawing it blank', () => {
    const s = newTransferForm();                  // receive, binary
    const text = transferLines(s, 'idle', undefined).join('\n');
    expect(text).not.toContain('Recfm');
    expect(text).not.toContain('Cr');
  });

  it('shows a field once it becomes applicable', () => {
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);
    const text = transferLines(s, 'idle', undefined).join('\n');
    expect(text).toContain('Recfm');
  });

  it('shows a text field value', () => {
    let s = newTransferForm();
    s = setFieldText(s, 'localFile', '/tmp/a.bin');
    expect(transferLines(s, 'idle', undefined).join('\n')).toContain('/tmp/a.bin');
  });

  it('shows the error when one is set, and the form stays drawn', () => {
    // A validation error keeps the form OPEN with the message shown, rather than closing
    // and discarding what was typed.
    const s = { ...newTransferForm(), error: 'Transfer(): missing LocalFile' };
    const text = transferLines(s, 'idle', undefined).join('\n');
    expect(text).toContain('missing LocalFile');
    expect(text).toContain('Direction');
  });

  it('shows progress while running', () => {
    const s = newTransferForm();
    const text = transferLines(s, 'running', '512 bytes').join('\n');
    expect(text).toContain('512 bytes');
  });

  it('shows the key help UNTRUNCATED, because it is the one line the user must read', () => {
    // NOT IN THE PLAN, WHICH SHIPPED A HELP STRING THAT DID NOT FIT: 59 characters
    // against a LINE_WIDTH of 54, so it rendered as `... Enter start  Esc >` and the key
    // that closes the form was the one cut off. The help text is a CONSTANT we choose,
    // unlike an error or a path, so it is the one status line that must fit rather than
    // truncate -- and the box must not widen to accommodate prose.
    //
    // ASSERTED ON THE LAST LINE, NOT ON THE JOINED TEXT. A first draft of this test
    // checked `not.toContain('>\n')` and PASSED against the plan's own oversized string,
    // because the status line is the LAST line and has no newline after it -- the
    // truncation marker it was looking for was the final character of the document.
    // Measured, not reasoned: the mutation put back the 59-character string and all 14
    // tests stayed green.
    const lines = transferLines(newTransferForm(), 'idle', undefined);
    const status = lines[lines.length - 1] ?? '';
    expect(status.trimEnd().endsWith('>')).toBe(false);
    expect(status).toMatch(/Tab/);
    expect(status).toMatch(/Enter/);
    // `Esc` alone is not enough: the oversized string was cut off mid-word AFTER `Esc`,
    // so the word that says what Esc does is what must be present.
    expect(status).toMatch(/Esc (close|cancel)/);
  });

  it('TRUNCATES a long value rather than widening the box', () => {
    // A 300-character path must not make the overlay wider than the terminal; the
    // alternative is a line that wraps and corrupts every row below it.
    let s = newTransferForm();
    s = setFieldText(s, 'localFile', '/x'.repeat(200));
    const lines = transferLines(s, 'idle', undefined);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(TRANSFER_MIN.cols);
  });

  it('TRUNCATES a long ERROR too, since the validator writes those and they are long', () => {
    // The real message for a repeated keyword runs past 54 characters, and a wrapped
    // status line would push the form's own rows off whatever window app.ts took.
    const s = { ...newTransferForm(), error: 'x'.repeat(300) };
    for (const l of transferLines(s, 'idle', undefined)) {
      expect(l.length).toBeLessThanOrEqual(TRANSFER_MIN.cols);
    }
  });
});
