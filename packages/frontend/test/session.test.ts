import { describe, it, expect, vi } from 'vitest';
import { defaultSession } from '../src/session.js';

/**
 * `defaultSession`'s geometry mode (Task 4 of the oversize plan; spec
 * docs/superpowers/specs/2026-11-04-oversize-and-model-switching-design.md). None of
 * these connect -- `Session`'s constructor alone is enough to observe `geometrySetting`
 * and `screen.alternateSize`, and a real TCP connect has no place in this package's tests.
 */

describe('defaultSession geometry mode', () => {
  it('passes the setting through, resolving the model\'s alternate size', () => {
    const session = defaultSession(
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { setting: { model: '3278-4-E', oversize: { kind: 'none' } } },
    );
    expect(session.geometrySetting).toEqual({ model: '3278-4-E', oversize: { kind: 'none' } });
    expect(session.screen.alternateSize).toEqual({ rows: 43, cols: 80 });
  });

  it('does not call measure merely to construct -- only a connect resolves auto', () => {
    const measure = vi.fn(() => ({ rows: 50, cols: 100 }));
    defaultSession(
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { setting: { model: '3278-2-E', oversize: { kind: 'auto' } }, measure },
    );
    expect(measure).not.toHaveBeenCalled();
  });
});
