import { describe, it, expect } from 'vitest';
import { Screen } from '../src/screen.js';
import { parseRecord } from '../src/stream/parse.js';
import { execute, ExecuteError } from '../src/stream/execute.js';
import { SnaCmd, Cmd, Order, FA, WCC, XA_3270 } from '../src/constants.js';

/** Parse and execute one record against a screen. */
function run(s: Screen, ...bytes: number[]) {
  return execute(s, parseRecord(Uint8Array.from(bytes)));
}

describe('write commands', () => {
  it('Write leaves existing content alone', () => {
    const s = new Screen();
    s.setChar(0, 0xc1);
    run(s, SnaCmd.W, 0x00, Order.SBA, 0xc2, 0x60, 0xc2);
    expect(s.cellAt(0).ebcdic).toBe(0xc1);
    expect(s.cellAt(160).ebcdic).toBe(0xc2);
  });

  it('Erase/Write clears the buffer first', () => {
    const s = new Screen();
    s.setChar(0, 0xc1);
    run(s, SnaCmd.EW, 0x00, Order.SBA, 0xc2, 0x60, 0xc2);
    expect(s.cellAt(0).ebcdic).toBe(0x00);
    expect(s.cellAt(160).ebcdic).toBe(0xc2);
  });

  it('Erase/Write Alternate behaves as Erase/Write on a model 2', () => {
    const s = new Screen();
    s.setChar(5, 0xc1);
    run(s, SnaCmd.EWA, 0x00);
    expect(s.cellAt(5).ebcdic).toBe(0x00);
  });

  it('Erase All Unprotected keeps protected data and attributes', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.SF, 0x00, 0xc1, Order.SBA, 0xc2, 0x60, Order.SF, FA.PROTECT, 0xc2);
    run(s, SnaCmd.EAU);
    expect(s.cellAt(1).ebcdic).toBe(0x00);
    expect(s.cellAt(161).ebcdic).toBe(0xc2);
    expect(s.isFieldAttribute(0)).toBe(true);
  });

  it('a write starts at address 0 by default', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, 0xc1, 0xc2);
    expect(s.cellAt(0).ebcdic).toBe(0xc1);
    expect(s.cellAt(1).ebcdic).toBe(0xc2);
  });
});

describe('WCC handling', () => {
  it('resets MDT in unprotected fields when bit 7 is set', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.MODIFY);
    run(s, SnaCmd.W, WCC.RESET_MDT);
    expect(s.fieldAt(1)!.modified).toBe(false);
  });

  it('reports a keyboard restore request', () => {
    const s = new Screen();
    const r = run(s, SnaCmd.W, WCC.KEYBOARD_RESTORE);
    expect(r.keyboardRestore).toBe(true);
    expect(run(s, SnaCmd.W, 0x00).keyboardRestore).toBe(false);
  });

  it('reports an alarm request', () => {
    const s = new Screen();
    expect(run(s, SnaCmd.W, WCC.SOUND_ALARM).alarm).toBe(true);
  });

  it('reports which commands release the enter-inhibit condition', () => {
    // The exact command set x3270 clears KL_ENTER_INHIBIT on, pinned here at
    // the layer that decides it rather than only through the session:
    // ctlr_erase for EW and EWA (Common/ctlr.c:550, dispatched at
    // ctlr.c:615-625), ctlr_erase_all_unprotected for EAU (ctlr.c:1309), and
    // ctlr_write for Write (ctlr.c:1406).
    //
    // Asserted WITHOUT WCC keyboard-restore (WCC 0x00), so what is being
    // measured is the command, not the bit. And asserted false for the reads,
    // WSF and NoOp, which is what makes a Query's inhibit outlast the reply
    // exchange — none of those three functions is on their path
    // (ctlr.c:632-657).
    const s = new Screen();
    expect(run(s, SnaCmd.W, 0x00).releasesEnterInhibit).toBe(true);
    expect(run(s, SnaCmd.EW, 0x00).releasesEnterInhibit).toBe(true);
    expect(run(s, SnaCmd.EWA, 0x00).releasesEnterInhibit).toBe(true);
    expect(run(s, SnaCmd.EAU).releasesEnterInhibit).toBe(true);

    expect(run(s, SnaCmd.RB).releasesEnterInhibit).toBe(false);
    expect(run(s, SnaCmd.RM).releasesEnterInhibit).toBe(false);
    expect(run(s, SnaCmd.RMA).releasesEnterInhibit).toBe(false);
    // WSF carrying a Read Partition (Query): L=5 SFID=01 PID=ff TYPE=02. No
    // IAC doubling here — parseRecord takes an already-unframed record.
    expect(run(s, SnaCmd.WSF, 0x00, 0x05, 0x01, 0xff, 0x02).releasesEnterInhibit)
      .toBe(false);
    expect(run(s, Cmd.NOP).releasesEnterInhibit).toBe(false);
  });

  it('reports that no printer is available for start-printer', () => {
    const s = new Screen();
    expect(run(s, SnaCmd.W, WCC.START_PRINTER).printerUnavailable).toBe(true);
  });
});

describe('orders', () => {
  it('SBA moves the write position', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.SBA, 0xc2, 0x60, 0xc1);
    expect(s.cellAt(160).ebcdic).toBe(0xc1);
  });

  it('SF plants a field attribute and advances past it', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.SF, FA.PROTECT, 0xc1);
    expect(s.attributeAt(0)).toBe(FA.PROTECT);
    expect(s.cellAt(1).ebcdic).toBe(0xc1);
  });

  it('IC sets the cursor to the current position', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.SBA, 0xc2, 0x60, Order.IC);
    expect(s.cursor).toBe(160);
  });

  it('RA fills from the current address up to but excluding the stop', () => {
    const s = new Screen();
    // Start at 10, repeat '*' (0x5c) to address 15.
    const [h, l] = [0xc0 | (15 >> 6), 0xc0 | (15 & 0x3f)];
    run(s, SnaCmd.W, 0x00, Order.SBA, 0xc0 | (10 >> 6), 0xc0 | (10 & 0x3f), Order.RA, h, l, 0x5c);
    for (let a = 10; a < 15; a++) expect(s.cellAt(a).ebcdic).toBe(0x5c);
    expect(s.cellAt(15).ebcdic).toBe(0x00);
  });

  it('RA to the current address fills the entire buffer', () => {
    // x3270 uses a do-while, so stop == start wraps all the way around.
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.RA, 0x40, 0x40, 0x5c);
    expect(s.cellAt(0).ebcdic).toBe(0x5c);
    expect(s.cellAt(1919).ebcdic).toBe(0x5c);
  });

  it('RA wraps around the end of the buffer to reach its stop', () => {
    const s = new Screen();
    // Start at 1918, stop at 2 — fills 1918, 1919, 0, 1.
    run(s, SnaCmd.W, 0x00,
      Order.SBA, 0xc0 | (1918 >> 6), 0xc0 | (1918 & 0x3f),
      Order.RA, 0xc0 | (2 >> 6), 0xc0 | (2 & 0x3f), 0x5c);
    expect(s.cellAt(1918).ebcdic).toBe(0x5c);
    expect(s.cellAt(1919).ebcdic).toBe(0x5c);
    expect(s.cellAt(0).ebcdic).toBe(0x5c);
    expect(s.cellAt(1).ebcdic).toBe(0x5c);
    expect(s.cellAt(2).ebcdic).toBe(0x00);
  });

  it('RA rejects a stop address past the end of the screen', () => {
    const s = new Screen();
    // 14-bit form so we can express an address beyond 1919.
    expect(() => run(s, SnaCmd.W, 0x00, Order.RA, 0x0f, 0xff, 0x5c))
      .toThrow(ExecuteError);
  });

  it('RA with a GE before the fill fills with the escaped character, not 0x08', () => {
    const s = new Screen();
    const [h, l] = [0xc0 | (5 >> 6), 0xc0 | (5 & 0x3f)];
    run(s, SnaCmd.W, 0x00, Order.RA, h, l, Order.GE, 0xf1);
    for (let a = 0; a < 5; a++) expect(s.cellAt(a).ebcdic).toBe(0xf1);
    expect(s.cellAt(5).ebcdic).toBe(0x00);
  });

  it('EUA nulls unprotected cells in a range and leaves protected ones', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00,
      Order.SF, 0x00, 0xc1, 0xc2,              // unprotected field at 0, data 1-2
      Order.SBA, 0xc0 | (10 >> 6), 0xc0 | (10 & 0x3f),
      Order.SF, FA.PROTECT, 0xc3);             // protected field at 10, data 11
    run(s, SnaCmd.W, 0x00,
      Order.SBA, 0x40, 0x40,
      Order.EUA, 0xc0 | (20 >> 6), 0xc0 | (20 & 0x3f));
    expect(s.cellAt(1).ebcdic).toBe(0x00);
    expect(s.cellAt(2).ebcdic).toBe(0x00);
    expect(s.cellAt(11).ebcdic).toBe(0xc3);
  });

  it('EUA rejects a stop address past the end of the screen', () => {
    const s = new Screen();
    // 14-bit form so we can express an address beyond 1919.
    expect(() => run(s, SnaCmd.W, 0x00, Order.EUA, 0x0f, 0xff))
      .toThrow(ExecuteError);
  });

  it('PT advances to the first data cell of the next unprotected field', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00,
      Order.SF, FA.PROTECT,                                   // protected at 0
      Order.SBA, 0xc0 | (10 >> 6), 0xc0 | (10 & 0x3f),
      Order.SF, 0x00);                                        // unprotected at 10
    const r = run(s, SnaCmd.W, 0x00, Order.PT, 0xc1);
    expect(r.programCheck).toBeUndefined();
    expect(s.cellAt(11).ebcdic).toBe(0xc1);
  });

  it('GE writes its character like data', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.GE, 0xf1);
    expect(s.cellAt(0).ebcdic).toBe(0xf1);
  });

  it('skips deferred orders without corrupting following data', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.SA, 0x42, 0xf2, 0xc1, 0xc2);
    expect(s.cellAt(0).ebcdic).toBe(0xc1);
    expect(s.cellAt(1).ebcdic).toBe(0xc2);
  });

  it('data wraps past the end of the buffer', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00,
      Order.SBA, 0xc0 | (1919 >> 6), 0xc0 | (1919 & 0x3f),
      0xc1, 0xc2);
    expect(s.cellAt(1919).ebcdic).toBe(0xc1);
    expect(s.cellAt(0).ebcdic).toBe(0xc2);
  });

  it('SFE defines a field with the 0xC0 pair as its attribute', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.SBA, 0x40, 0x40, Order.SFE, 0x01, XA_3270, 0x60);
    expect(s.attributeAt(0)).toBe(0x60);
    expect(s.isFormatted()).toBe(true);
    expect(s.fieldAt(1)?.protected).toBe(true);
  });

  it('SFE with no 0xC0 pair STILL defines a field, with the default attribute', () => {
    // p. 4-5: unspecified attribute types take their defaults. Skipping the
    // field here would lose it entirely, which is the failure SFE exists to
    // prevent. Type 0x42 is colour, which we do not honour.
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.SBA, 0x40, 0x40, Order.SFE, 0x01, 0x42, 0xf4);
    expect(s.attributeAt(0)).toBe(0x00);
    expect(s.isFormatted()).toBe(true);
  });

  it('SFE with zero pairs defines a field with the default attribute', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.SBA, 0x40, 0x40, Order.SFE, 0x00);
    expect(s.attributeAt(0)).toBe(0x00);
    expect(s.isFormatted()).toBe(true);
  });

  it('SFE advances past the attribute position like SF does', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.SBA, 0x40, 0x40, Order.SFE, 0x01, XA_3270, 0x60, 0xc1);
    // The data byte lands AFTER the attribute, at address 1.
    expect(s.cellAt(1).ebcdic).toBe(0xc1);
  });

  it('SFE ignores pair types it does not honour but keeps the field attribute', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.SBA, 0x40, 0x40,
      Order.SFE, 0x02, 0x42, 0xf4, XA_3270, 0x60);
    expect(s.attributeAt(0)).toBe(0x60);
  });

  it('SFE takes the LAST 0xC0 pair when the type repeats', () => {
    // p. 4-5 (pages.txt:2899-2901): "All attribute types and values are checked
    // for validity. If the same attribute / type-value pair appears more than
    // once, the last specification for a repeated / attribute type takes
    // effect." x3270 gets this for free: its pair loop calls START_FIELD on
    // every 0xC0 it meets, so the last write to the buffer wins
    // (ctlr.c:1838-1842).
    //
    // 0xE8 for the second value, NOT 0x00: the no-pair default is also 0x00, so
    // expecting that would pass for an implementation that gave up on a repeated
    // type and fell back to the default. 0xE8 is distinguishable from both the
    // first value and the default, and it doubles as the suite's only
    // realistically-shaped attribute byte — printable bits on (0xC0, which
    // Field.attr's contract at screen.ts:36-43 says every real host sets), plus
    // protect 0x20 and FA.INT_HIGH_SEL 0x08. Asserting on it therefore also pins
    // that we pass the byte through unmasked rather than normalizing it.
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.SBA, 0x40, 0x40,
      Order.SFE, 0x02, XA_3270, 0x60, XA_3270, 0xe8);
    expect(s.attributeAt(0)).toBe(0xe8);
    expect(s.fieldAt(1)?.intensified).toBe(true);
  });

  it('counts SA and MF separately so the live run can measure them', () => {
    // A COUNTER THAT REPORTS ABSENCE MUST FIRST BE SHOWN ABLE TO REPORT
    // PRESENCE. Stage 1 lesson 7: a probe that could only ever say "never"
    // produced a confident wrong claim that reached committed docs. These
    // assertions are that proof.
    //
    // TWO SA orders and ONE MF, deliberately asymmetric. With one of each, both
    // counters read 1 whichever order increments which, so swapping the two
    // cases in the counting loop passes — and that swap is not cosmetic:
    // modifyFieldIgnored is the documented fold-into-2b trigger, so under it a
    // host sending only SA would trigger a stage-2b fold on evidence that does
    // not exist, which is the exact lesson-7 failure this test cites. The
    // asymmetry also pins that repeats of one order accumulate rather than
    // saturating at 1.
    const s = new Screen();
    const r = run(s, SnaCmd.W, 0x00,
      Order.SA, 0x42, 0xf4,
      Order.SA, 0x42, 0xf5,
      Order.MF, 0x01, XA_3270, 0x60);
    expect(r.setAttributeIgnored).toBe(2);
    expect(r.modifyFieldIgnored).toBe(1);
  });

  it('reports zero ignored orders for a record containing none', () => {
    const s = new Screen();
    const r = run(s, SnaCmd.W, 0x00, 0xc1);
    expect(r.setAttributeIgnored).toBe(0);
    expect(r.modifyFieldIgnored).toBe(0);
  });

  it('a field attribute overwritten by data destroys the field', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.SBA, 0xc0 | (10 >> 6), 0xc0 | (10 & 0x3f), Order.SF, FA.PROTECT);
    expect(s.fields()).toHaveLength(1);
    run(s, SnaCmd.W, 0x00, Order.SBA, 0xc0 | (10 >> 6), 0xc0 | (10 & 0x3f), 0xc1);
    expect(s.fields()).toHaveLength(0);
  });
});

describe('read commands', () => {
  it('reports which read the host asked for without mutating the screen', () => {
    const s = new Screen();
    s.setChar(0, 0xc1);
    expect(run(s, SnaCmd.RB).readRequest).toBe('ReadBuffer');
    expect(run(s, SnaCmd.RM).readRequest).toBe('ReadModified');
    expect(run(s, SnaCmd.RMA).readRequest).toBe('ReadModifiedAll');
    expect(s.cellAt(0).ebcdic).toBe(0xc1);
  });
});

describe('structured fields and no-op', () => {
  it('ignores a WSF payload but reports that one arrived', () => {
    const s = new Screen();
    // A well-formed field with an SFID we do not implement. The old payload
    // declared a length of 5 with only 4 bytes present, which typed SF parsing
    // now rejects. An unknown SFID rather than a Read Partition Query on
    // purpose: this test is about the ignored-field counter, and task 7 makes a
    // Query set an sfReply intent instead of incrementing it.
    const r = run(s, SnaCmd.WSF, 0x00, 0x04, 0x40, 0xaa);
    expect(r.structuredFieldsIgnored).toBe(1);
  });

  it('does nothing for a NoOp', () => {
    const s = new Screen();
    s.setChar(0, 0xc1);
    run(s, 0x03);
    expect(s.cellAt(0).ebcdic).toBe(0xc1);
  });
});
