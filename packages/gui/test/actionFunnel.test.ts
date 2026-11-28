import { describe, it, expect } from 'vitest';
import { applyGuarded, isActionShaped } from '../src/actionFunnel.js';

describe('the action funnel', () => {
  it('applies a good action and reports nothing', () => {
    const seen: unknown[] = []; const lines: string[] = [];
    expect(applyGuarded((a) => { seen.push(a); }, { kind: 'enter' }, (l) => lines.push(l))).toBe(true);
    expect(seen).toEqual([{ kind: 'enter' }]);
    expect(lines).toEqual([]);
  });
  it('a throw is REPORTED BY KIND AND DROPPED, not propagated (it froze the main process)', () => {
    const lines: string[] = [];
    const ok = applyGuarded(() => { throw new Error('applyAction does not handle paste: x'); },
      { kind: 'paste' }, (l) => lines.push(l));
    expect(ok).toBe(false);
    expect(lines).toEqual(['action dropped: paste: applyAction does not handle paste: x']);
  });
  it('a non-Error throw is reported too', () => {
    const lines: string[] = [];
    applyGuarded(() => { throw 'boom'; }, { kind: 'attn' }, (l) => lines.push(l));
    expect(lines).toEqual(['action dropped: attn: boom']);
  });
  it('shape: an object with a string kind, and nothing else', () => {
    expect(isActionShaped({ kind: 'enter' })).toBe(true);
    for (const bad of [undefined, null, 'enter', 3, {}, { kind: 7 }, { kind: '' }, []]) {
      expect(isActionShaped(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
