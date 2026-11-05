import { describe, it, expect } from 'vitest';
import {
  OversizeError, resolveGeometry, type GeometrySetting,
} from '@tn3270/core';
import { applyGeometryChoice } from '../src/geometryChoice.js';

/** The fixed-size fallback's text, exactly: outcome first, and no size the menu cannot type. */
const FIXED_TEXT =
  'oversize is now None: 100x30 is smaller than model 3278-5-E; pick Auto, or a model it fits';

/**
 * THE ORDER-DEPENDENCE RULE. A menu changes ONE thing per click, and `resolveGeometry` validates
 * model and oversize together -- the CLI's `Set()` found that some single steps are refused
 * (commit 1a4713e). A model choice is the operator's latest explicit intent, so when the current
 * oversize is what refuses it, the model wins and the oversize drops to None, and they are told.
 */
describe('applyGeometryChoice', () => {
  const real = (): { set: (g: GeometrySetting) => void; calls: GeometrySetting[] } => {
    const calls: GeometrySetting[] = [];
    return { calls, set: (g) => { calls.push(g); resolveGeometry(g, () => undefined); } };
  };

  it('applies a model with the current oversize when that fits, and says nothing', () => {
    const r = real();
    const current: GeometrySetting = { model: '3278-2-E', oversize: { kind: 'fixed', rows: 62, cols: 160 } };
    expect(applyGeometryChoice(current, { model: '3278-5-E' }, r.set)).toBeUndefined();
    expect(r.calls).toEqual([{ model: '3278-5-E', oversize: { kind: 'fixed', rows: 62, cols: 160 } }]);
  });

  it('drops a fixed oversize below the new model to None, and says so action first', () => {
    const r = real();
    const current: GeometrySetting = { model: '3278-2-E', oversize: { kind: 'fixed', rows: 30, cols: 100 } };
    const notice = applyGeometryChoice(current, { model: '3278-5-E' }, r.set);
    expect(r.calls).toEqual([
      { model: '3278-5-E', oversize: { kind: 'fixed', rows: 30, cols: 100 } },
      { model: '3278-5-E', oversize: { kind: 'none' } },
    ]);
    expect(notice).toBe(FIXED_TEXT);
    // NOT core's `use at least 132x27`: that is a size the menu cannot type.
    expect(notice).not.toContain('132x27');
  });

  it('drops Auto to None when the new model has no extended data stream', () => {
    const r = real();
    const notice = applyGeometryChoice({ oversize: { kind: 'auto' } }, { model: '3278-4' }, r.set);
    expect(r.calls.at(-1)).toEqual({ model: '3278-4', oversize: { kind: 'none' } });
    expect(notice).toBe(
      'oversize is now None: model 3278-4 has no extended data stream; pick 3278-4-E for an oversize');
    // Not core's remedy, which is a command-line flag (`use -model 3278-4-E`).
    expect(notice).not.toContain('-model');
  });

  it('passes an oversize choice through, and its refusal unchanged', () => {
    const r = real();
    expect(applyGeometryChoice({ model: '3278-3-E', oversize: { kind: 'none' } },
      { oversize: { kind: 'auto' } }, r.set)).toBeUndefined();
    expect(r.calls).toEqual([{ model: '3278-3-E', oversize: { kind: 'auto' } }]);
    // A fixed size below the model is refused, NOT fixed up by changing the model behind it.
    expect(() => applyGeometryChoice({ model: '3278-5-E', oversize: { kind: 'none' } },
      { oversize: { kind: 'fixed', rows: 30, cols: 100 } }, r.set)).toThrow(/use at least 132x27/);
    expect(r.calls).toHaveLength(2);
  });

  it('does not retry a refusal that is not about the oversize', () => {
    const calls: GeometrySetting[] = [];
    const refuse = (g: GeometrySetting): void => {
      calls.push(g);
      throw new Error('disconnect first; model and oversize apply at the next connect');
    };
    expect(() => applyGeometryChoice({ model: '3278-2-E', oversize: { kind: 'fixed', rows: 30, cols: 100 } },
      { model: '3278-5-E' }, refuse)).toThrow(/^disconnect first/);
    expect(calls).toHaveLength(1);
  });

  it('does not retry when the oversize is already None', () => {
    const calls: GeometrySetting[] = [];
    const refuse = (g: GeometrySetting): void => { calls.push(g); throw new OversizeError('nope'); };
    expect(() => applyGeometryChoice({ oversize: { kind: 'none' } }, { model: '3278-5-E' }, refuse))
      .toThrow('nope');
    expect(calls).toHaveLength(1);
  });

  it('reports the RETRY\'s refusal when None is refused too, not the first one', () => {
    let n = 0;
    const refuse = (): void => { n += 1; throw new OversizeError(`refusal ${n}`); };
    expect(() => applyGeometryChoice({ oversize: { kind: 'auto' } }, { model: '3278-5' }, refuse))
      .toThrow('refusal 2');
  });
});

describe('applyGeometryChoice: the review fixes', () => {
  const real = (): { set: (g: GeometrySetting) => void; calls: GeometrySetting[] } => {
    const calls: GeometrySetting[] = [];
    return { calls, set: (g) => { calls.push(g); resolveGeometry(g, () => undefined); } };
  };

  it('names the model as core resolves it, whatever spelling the choice used', () => {
    const r = real();
    expect(applyGeometryChoice({ oversize: { kind: 'auto' } }, { model: 'ibm-3278-4' }, r.set))
      .toBe('oversize is now None: model 3278-4 has no extended data stream; pick 3278-4-E for an oversize');
  });

  it('gets the startup fixed size back: fallback to None, a model it fits, then the size', () => {
    // From 3278-2-E at 100x30 (the startup size), 3278-5-E drops the oversize to None. The way
    // back to 100x30 is a model it fits and then the size again -- each step accepted.
    const r = real();
    const startup = { kind: 'fixed', rows: 30, cols: 100 } as const;
    let current: GeometrySetting = { model: '3278-2-E', oversize: startup };
    const step = (c: Parameters<typeof applyGeometryChoice>[1]): string | undefined => {
      const notice = applyGeometryChoice(current, c, (g) => { r.set(g); current = g; });
      return notice;
    };
    expect(step({ model: '3278-5-E' })).toBe(FIXED_TEXT);
    expect(current).toEqual({ model: '3278-5-E', oversize: { kind: 'none' } });
    expect(() => step({ oversize: startup })).toThrow(/use at least 132x27/);
    // 3278-3-E (32x80) is not one it fits either: the size stays refused there.
    expect(step({ model: '3278-3-E' })).toBeUndefined();
    expect(() => step({ oversize: startup })).toThrow(/use at least 80x32/);
    expect(step({ model: '3278-2-E' })).toBeUndefined();
    expect(step({ oversize: startup })).toBeUndefined();
    expect(current).toEqual({ model: '3278-2-E', oversize: startup });
  });

  it('rethrows an OversizeError it cannot explain, rather than resetting silently', () => {
    // An -E model with a fixed size that FITS it is not the oversize's fault; nothing to reset.
    const calls: GeometrySetting[] = [];
    const refuse = (g: GeometrySetting): void => { calls.push(g); throw new OversizeError('other'); };
    expect(() => applyGeometryChoice(
      { model: '3278-2-E', oversize: { kind: 'fixed', rows: 62, cols: 160 } },
      { model: '3278-4-E' }, refuse)).toThrow('other');
    expect(calls).toHaveLength(1);
  });
});
