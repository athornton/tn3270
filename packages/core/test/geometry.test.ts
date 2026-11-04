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
  it('trims surrounding whitespace', () => {
    expect(parseOversize(' 160x62 ')).toEqual({ kind: 'fixed', rows: 62, cols: 160 });
  });
  it('reads auto and none, case-free', () => {
    expect(parseOversize('AUTO')).toEqual({ kind: 'auto' });
    expect(parseOversize('none')).toEqual({ kind: 'none' });
    expect(parseOversize('NONE')).toEqual({ kind: 'none' });
  });
  it.each(['', '80', '80x', 'x24', '80x24x1', '80 x 24', '-80x24', '80.5x24', '0x24', '80x0'])(
    'refuses %j with the expected form in the message', (bad) => {
      expect(() => parseOversize(bad)).toThrow(OversizeError);
      expect(() => parseOversize(bad)).toThrow(/<cols>x<rows>, auto or none/);
    });
  it('refuses a digit string so long it is not a safe integer, at parse time', () => {
    // 20 nines: survives the regexp (all digits) but Number(...) is not a safe integer, and a
    // long enough run (300+ digits) is not even finite. Either must be refused here, with the
    // ordinary parse message, rather than let an Infinity or an imprecise huge number reach the
    // cell-count arithmetic as e.g. `Infinityx24`.
    expect(() => parseOversize('99999999999999999999x24')).toThrow(/<cols>x<rows>, auto or none/);
    expect(() => parseOversize(`${'9'.repeat(400)}x24`)).toThrow(/<cols>x<rows>, auto or none/);
  });
  it('truncates a huge echoed argument so it cannot push the message off a line', () => {
    const huge = `${'8'.repeat(100)}x24`;
    expect(() => parseOversize(huge)).toThrow(/^-oversize takes <cols>x<rows>, auto or none, not "8{20}\.\.\."$/);
  });
  it('truncates a huge echoed argument on the zero-size path too', () => {
    const huge = `${'0'.repeat(50)}x24`;
    expect(() => parseOversize(huge)).toThrow(/^-oversize takes <cols>x<rows>, auto or none, not "0{20}\.\.\."$/);
  });
});

describe('resolveGeometry, none', () => {
  it('is the model, unchanged: its terminal type and its alternate', () => {
    const g = resolveGeometry({ model: '3278-4-E', oversize: { kind: 'none' } });
    expect(g).toEqual({
      terminalType: 'IBM-3278-4-E', default: { rows: 24, cols: 80 },
      alternate: { rows: 43, cols: 80 }, dynamic: false,
    });
    // No `notice` or `clamp` key at all -- not merely undefined -- on the plain path.
    expect('notice' in g).toBe(false);
    expect('clamp' in g).toBe(false);
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
  it('never calls measure for none', () => {
    let calls = 0;
    resolveGeometry({ oversize: { kind: 'none' } }, () => { calls += 1; return { rows: 24, cols: 80 }; });
    expect(calls).toBe(0);
  });
});

describe('resolveGeometry, fixed', () => {
  it('is IBM-DYNAMIC with the oversize as the alternate, default still 24x80', () => {
    const g = resolveGeometry({ model: '3278-2-E', oversize: { kind: 'fixed', rows: 62, cols: 160 } });
    expect(g).toEqual({
      terminalType: 'IBM-DYNAMIC', default: { rows: 24, cols: 80 },
      alternate: { rows: 62, cols: 160 }, dynamic: true,
    });
  });
  it('refuses a model that does not claim the extended data stream', () => {
    // x3270 silently drops oversize without `extended_data_stream` (model.c:204-205,
    // "Without extended, no oversize" at :333-335); we refuse instead, because dropping it
    // silently would connect with a geometry the operator did not ask for.
    expect(() => resolveGeometry({ model: '3278-2', oversize: { kind: 'fixed', rows: 30, cols: 100 } }))
      .toThrow(/^oversize needs an extended model: use -model 3278-2-E -- model 3278-2 does not claim /);
  });
  it('still gives IBM-DYNAMIC for an explicit -E model', () => {
    expect(resolveGeometry({ model: '3278-2-E', oversize: { kind: 'fixed', rows: 30, cols: 100 } })
      .terminalType).toBe('IBM-DYNAMIC');
  });
  it('accepts exactly the model size and exactly 16383 cells', () => {
    const atModel = resolveGeometry({ model: '3278-4-E', oversize: { kind: 'fixed', rows: 43, cols: 80 } });
    expect(atModel.alternate).toEqual({ rows: 43, cols: 80 });
    expect(atModel.dynamic).toBe(true);
    expect(MAX_OVERSIZE_CELLS).toBe(0x3fff);
    const atLimit = resolveGeometry({ oversize: { kind: 'fixed', rows: 127, cols: 129 } }); // 16383
    expect(atLimit.alternate).toEqual({ rows: 127, cols: 129 });
    expect(atLimit.dynamic).toBe(true);
  });
  it('refuses fewer columns than the model, remedy first', () => {
    expect(() => resolveGeometry({ model: '3278-5-E', oversize: { kind: 'fixed', rows: 30, cols: 100 } }))
      .toThrow(/^oversize 100x30 refused: use at least 132x27 -- model 3278-5-E is 27 rows by 132 columns$/);
  });
  it('refuses fewer rows than the model', () => {
    expect(() => resolveGeometry({ model: '3278-4-E', oversize: { kind: 'fixed', rows: 40, cols: 100 } }))
      .toThrow(/use at least 80x43/);
  });
  it('refuses more than 16383 cells, naming the limit', () => {
    expect(() => resolveGeometry({ oversize: { kind: 'fixed', rows: 128, cols: 128 } }))
      .toThrow(/^oversize 128x128 refused: use at most 16383 cells -- that is 16384$/);
  });
  it('refuses oversize together with --terminal-type', () => {
    expect(() => resolveGeometry({ terminalType: 'IBM-3278-2', oversize: { kind: 'fixed', rows: 30, cols: 80 } }))
      .toThrow(/-oversize and --terminal-type cannot both be given/);
  });
  it('refuses a programmatic fixed size that is not a positive integer, naming the value', () => {
    expect(() => resolveGeometry({ oversize: { kind: 'fixed', rows: 24, cols: -1 } }))
      .toThrow(/cols, not -1/);
    expect(() => resolveGeometry({ oversize: { kind: 'fixed', rows: 0, cols: 80 } }))
      .toThrow(/rows, not 0/);
    expect(() => resolveGeometry({ oversize: { kind: 'fixed', rows: 24.5, cols: 80 } }))
      .toThrow(/rows, not 24\.5/);
  });
  it('never calls measure for a fixed size', () => {
    let calls = 0;
    resolveGeometry(
      { model: '3278-2-E', oversize: { kind: 'fixed', rows: 30, cols: 100 } },
      () => { calls += 1; return { rows: 24, cols: 80 }; },
    );
    expect(calls).toBe(0);
  });
});

describe('resolveGeometry, auto', () => {
  const auto = { kind: 'auto' } as const;
  it('takes exactly what fits, not a snapped size', () => {
    const g = resolveGeometry({ model: '3278-2-E', oversize: auto }, () => ({ rows: 50, cols: 133 }));
    expect(g.alternate).toEqual({ rows: 50, cols: 133 });
    expect(g.terminalType).toBe('IBM-DYNAMIC');
    expect(g.dynamic).toBe(true);
    expect(g.notice).toBeUndefined();
  });
  it('accepts a window exactly the model size', () => {
    const g = resolveGeometry({ model: '3278-2-E', oversize: auto }, () => ({ rows: 24, cols: 80 }));
    expect(g.terminalType).toBe('IBM-DYNAMIC');
    expect(g.alternate).toEqual({ rows: 24, cols: 80 });
    expect(g.dynamic).toBe(true);
    expect(g.notice).toBeUndefined();
  });
  it('accepts a window of exactly 16383 cells with no clamp', () => {
    const g = resolveGeometry({ oversize: auto }, () => ({ rows: 127, cols: 129 })); // 16383
    expect(g.alternate).toEqual({ rows: 127, cols: 129 });
    expect(g.dynamic).toBe(true);
    expect(g.clamp).toBeUndefined();
  });
  it('refuses a model that does not claim the extended data stream, same as fixed', () => {
    expect(() => resolveGeometry({ model: '3278-2', oversize: auto }, () => ({ rows: 30, cols: 100 })))
      .toThrow(/^oversize needs an extended model: use -model 3278-2-E/);
  });
  it('falls back to the model when the window is too small in rows, and says so', () => {
    const g = resolveGeometry({ model: '3278-2-E', oversize: auto }, () => ({ rows: 22, cols: 80 }));
    expect(g).toMatchObject({ terminalType: 'IBM-3278-2-E', alternate: { rows: 24, cols: 80 }, dynamic: false });
    expect(g.notice).toBe('oversize auto: window fits 22 rows by 80 columns, less than model '
      + '3278-2-E\'s 24 rows by 80 columns; using the model');
  });
  it('falls back to the model when the window is too small in columns', () => {
    const g = resolveGeometry({ model: '3278-5-E', oversize: auto }, () => ({ rows: 30, cols: 100 }));
    expect(g).toMatchObject({ terminalType: 'IBM-3278-5-E', alternate: { rows: 27, cols: 132 }, dynamic: false });
    expect(g.notice).toMatch(/less than model 3278-5-E's 27 rows by 132 columns/);
  });
  it('falls back when nothing can be measured yet', () => {
    const g = resolveGeometry({ model: '3278-2-E', oversize: auto }, () => undefined);
    expect(g.terminalType).toBe('IBM-3278-2-E');
    expect(g.alternate).toEqual({ rows: 24, cols: 80 });
    expect(g.dynamic).toBe(false);
    expect(g.notice).toBe('oversize auto: no window size known; using the model');
  });
  it.each([
    { rows: NaN, cols: 80 }, { rows: 24.5, cols: 80 }, { rows: 0, cols: 80 }, { rows: -5, cols: 80 },
  ])('falls back when measure returns a non-positive-integer size %j', (bad) => {
    const g = resolveGeometry({ model: '3278-2-E', oversize: auto }, () => bad);
    expect(g.dynamic).toBe(false);
    expect(g.notice).toBe('oversize auto: no window size known; using the model');
  });
  it('copies what measure returns rather than aliasing it', () => {
    const fits = { rows: 50, cols: 133 };
    const g = resolveGeometry({ model: '3278-2-E', oversize: auto }, () => fits);
    expect(g.alternate).toEqual(fits);
    expect(g.alternate).not.toBe(fits);
  });
  it('cuts rows past 16383 cells, keeping the width, and notes it as a clamp', () => {
    const g = resolveGeometry({ oversize: auto }, () => ({ rows: 200, cols: 200 }));
    expect(g.terminalType).toBe('IBM-DYNAMIC');
    expect(g.alternate).toEqual({ rows: 81, cols: 200 }); // floor(16383 / 200)
    expect(g.dynamic).toBe(true);
    expect(g.clamp).toBe('oversize auto: window fits 200 rows by 200 columns; cut to 81 rows, the 14-bit address limit');
  });
  it('falls back to the model when the clamp would cut below the model floor', () => {
    // Model 3278-4-E's alternate is 43x80, so this window passes the "too small" check (43 rows,
    // well over 80 columns) but 43*400 = 17200 cells overflows the limit, and cutting to fit
    // (floor(16383/400) = 40 rows) would hand back FEWER rows than the model guarantees.
    const g = resolveGeometry({ model: '3278-4-E', oversize: auto }, () => ({ rows: 43, cols: 400 }));
    expect(g.terminalType).toBe('IBM-3278-4-E');
    expect(g.alternate).toEqual({ rows: 43, cols: 80 });
    expect(g.dynamic).toBe(false);
    expect(g.notice).toMatch(/too wide/);
  });
  it('refuses auto with no measure function, asking for a fixed size', () => {
    expect(() => resolveGeometry({ oversize: auto }))
      .toThrow(/^oversize auto needs a window to measure; give -oversize <cols>x<rows> instead$/);
  });
});

describe('canonical model name in messages', () => {
  it('uses the resolved terminal type, not the string as typed', () => {
    expect(() => resolveGeometry({ model: 'ibm-3278-4-e', oversize: { kind: 'fixed', rows: 10, cols: 10 } }))
      .toThrow(/model 3278-4-E is 43 rows by 80 columns/);
  });
});

describe('describeSize', () => {
  it('says rows and columns in words', () => {
    expect(describeSize({ rows: 62, cols: 160 })).toBe('62 rows by 160 columns');
  });
});
