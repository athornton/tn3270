import { describe, it, expect } from 'vitest';
import {
  parseOversize, resolveGeometry, describeSize, MAX_OVERSIZE_CELLS, OversizeError,
} from '../src/geometry.js';
import { TerminalTypeError } from '../src/termtype.js';

describe('parseOversize', () => {
  it('reads <cols>x<rows>, x3270 order, so 160x62 is 62 rows by 160 columns', () => {
    expect(parseOversize('160x62')).toEqual({ kind: 'fixed', rows: 62, cols: 160 });
    expect(parseOversize('132X27')).toEqual({ kind: 'fixed', rows: 27, cols: 132 });
  });
  it('reads auto and none, case-free', () => {
    expect(parseOversize('AUTO')).toEqual({ kind: 'auto' });
    expect(parseOversize('none')).toEqual({ kind: 'none' });
  });
  it.each(['', '80', '80x', 'x24', '80x24x1', '80 x 24', '-80x24', '80.5x24', '0x24', '80x0'])(
    'refuses %j with the expected form in the message', (bad) => {
      expect(() => parseOversize(bad)).toThrow(OversizeError);
      expect(() => parseOversize(bad)).toThrow(/<cols>x<rows>, auto or none/);
    });
});

describe('resolveGeometry, none', () => {
  it('is the model, unchanged: its terminal type and its alternate', () => {
    const g = resolveGeometry({ model: '3278-4-E', oversize: { kind: 'none' } });
    expect(g).toEqual({
      terminalType: 'IBM-3278-4-E', default: { rows: 24, cols: 80 },
      alternate: { rows: 43, cols: 80 }, oversize: false,
    });
  });
  it('with no model is the product default, IBM-3278-2-E at 24x80', () => {
    const g = resolveGeometry({ oversize: { kind: 'none' } });
    expect(g.terminalType).toBe('IBM-3278-2-E');
    expect(g.alternate).toEqual({ rows: 24, cols: 80 });
  });
  it('passes a raw --terminal-type through and keeps 24x80, as resolveAlternateSize does', () => {
    const g = resolveGeometry({ terminalType: 'IBM-3279-5', oversize: { kind: 'none' } });
    expect(g.terminalType).toBe('IBM-3279-5');
    expect(g.alternate).toEqual({ rows: 24, cols: 80 });
  });
  it('propagates an unknown model exactly as resolveTerminalType does', () => {
    expect(() => resolveGeometry({ model: '3278-9', oversize: { kind: 'none' } }))
      .toThrow(TerminalTypeError);
  });
});

describe('resolveGeometry, fixed', () => {
  it('is IBM-DYNAMIC with the oversize as the alternate, default still 24x80', () => {
    const g = resolveGeometry({ model: '3278-2-E', oversize: { kind: 'fixed', rows: 62, cols: 160 } });
    expect(g).toEqual({
      terminalType: 'IBM-DYNAMIC', default: { rows: 24, cols: 80 },
      alternate: { rows: 62, cols: 160 }, oversize: true,
    });
  });
  it('is IBM-DYNAMIC even for a model without -E, as x3270 (telnet.c:2100)', () => {
    expect(resolveGeometry({ model: '3278-2', oversize: { kind: 'fixed', rows: 30, cols: 100 } })
      .terminalType).toBe('IBM-DYNAMIC');
  });
  it('accepts exactly the model size and exactly 16383 cells', () => {
    expect(resolveGeometry({ model: '3278-4', oversize: { kind: 'fixed', rows: 43, cols: 80 } })
      .alternate).toEqual({ rows: 43, cols: 80 });
    expect(MAX_OVERSIZE_CELLS).toBe(0x3fff);
    expect(() => resolveGeometry({ oversize: { kind: 'fixed', rows: 127, cols: 129 } }))
      .not.toThrow(); // 16383
  });
  it('refuses fewer columns than the model, remedy first', () => {
    expect(() => resolveGeometry({ model: '3278-5', oversize: { kind: 'fixed', rows: 30, cols: 100 } }))
      .toThrow(/^oversize 100x30 refused: use at least 132x27 -- model 3278-5 is 27 rows by 132 columns$/);
  });
  it('refuses fewer rows than the model', () => {
    expect(() => resolveGeometry({ model: '3278-4', oversize: { kind: 'fixed', rows: 40, cols: 100 } }))
      .toThrow(/use at least 80x43/);
  });
  it('refuses more than 16383 cells, naming the limit', () => {
    expect(() => resolveGeometry({ oversize: { kind: 'fixed', rows: 128, cols: 128 } }))
      .toThrow(/^oversize 128x128 refused: 16384 cells is more than the 16383 a 14-bit address reaches$/);
  });
  it('refuses oversize together with --terminal-type', () => {
    expect(() => resolveGeometry({ terminalType: 'IBM-3278-2', oversize: { kind: 'fixed', rows: 30, cols: 80 } }))
      .toThrow(/-oversize and --terminal-type cannot both be given/);
  });
});

describe('resolveGeometry, auto', () => {
  const auto = { kind: 'auto' } as const;
  it('takes exactly what fits, not a snapped size', () => {
    const g = resolveGeometry({ model: '3278-2-E', oversize: auto, measure: () => ({ rows: 50, cols: 133 }) });
    expect(g.alternate).toEqual({ rows: 50, cols: 133 });
    expect(g.terminalType).toBe('IBM-DYNAMIC');
    expect(g.notice).toBeUndefined();
  });
  it('falls back to the model when the window is too small, and says so', () => {
    const g = resolveGeometry({ model: '3278-2-E', oversize: auto, measure: () => ({ rows: 22, cols: 80 }) });
    expect(g).toMatchObject({ terminalType: 'IBM-3278-2-E', alternate: { rows: 24, cols: 80 }, oversize: false });
    expect(g.notice).toBe('oversize auto: window fits 22 rows by 80 columns, less than model '
      + '3278-2-E\'s 24 rows by 80 columns; using the model');
  });
  it('falls back when nothing can be measured yet', () => {
    const g = resolveGeometry({ model: '3278-2-E', oversize: auto, measure: () => undefined });
    expect(g.oversize).toBe(false);
    expect(g.notice).toBe('oversize auto: no window size known; using the model');
  });
  it('cuts rows past 16383 cells, keeping the width, and notes it as a clamp', () => {
    const g = resolveGeometry({ oversize: auto, measure: () => ({ rows: 200, cols: 200 }) });
    expect(g.alternate).toEqual({ rows: 81, cols: 200 }); // floor(16383 / 200)
    expect(g.clamp).toBe('oversize auto: window fits 200 rows by 200 columns; cut to 81 rows, the 14-bit address limit');
  });
  it('falls back to the model when the clamp would cut below the model floor', () => {
    // Model 3278-4's alternate is 43x80, so this window passes the "too small" check (43 rows,
    // well over 80 columns) but 43*400 = 17200 cells overflows the limit, and cutting to fit
    // (floor(16383/400) = 40 rows) would hand back FEWER rows than the model guarantees.
    const g = resolveGeometry({ model: '3278-4', oversize: auto, measure: () => ({ rows: 43, cols: 400 }) });
    expect(g.oversize).toBe(false);
    expect(g.notice).toMatch(/too wide/);
  });
  it('refuses auto with no measure function, asking for a fixed size', () => {
    expect(() => resolveGeometry({ oversize: auto }))
      .toThrow(/^oversize auto needs a window to measure; give -oversize <cols>x<rows> instead$/);
  });
});

describe('describeSize', () => {
  it('says rows and columns in words', () => {
    expect(describeSize({ rows: 62, cols: 160 })).toBe('62 rows by 160 columns');
  });
});
