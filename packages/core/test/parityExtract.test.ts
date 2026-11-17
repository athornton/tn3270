import { describe, it, expect } from 'vitest';
import { guardsByLine, linkedSources, makeVar, parseDefines } from '../../../scripts/parity-extract.mjs';

describe('parity-extract primitives', () => {
  it('makeVar joins continuation lines and strips .o', () => {
    const mk = '# c\nX3270_OBJECTS = a.o b.o \\\n\tc.o\nOTHER = z.o\n';
    expect(makeVar(mk, 'X3270_OBJECTS')).toEqual(['a', 'b', 'c']);
    expect(() => makeVar(mk, 'NOPE')).toThrow(/NOPE/);
  });

  it('parseDefines resolves literals and "." Ident concatenation, and drops non-strings', () => {
    const d = parseDefines([
      '#define ResProxy\t\t"proxy"',
      '#define DotProxy\t\t"." ResProxy',
      '#define OptProxy\t"-proxy"  /* comment */',
      '#define NUM 3',
    ].join('\n'));
    expect(d.get('ResProxy')).toBe('proxy');
    expect(d.get('DotProxy')).toBe('.proxy');
    expect(d.get('OptProxy')).toBe('-proxy');
    expect(d.has('NUM')).toBe(false);
  });

  it('linkedSources: x3270 objects minus widgets, plus the three Common libs, sorted', () => {
    const files: Record<string, string> = {
      'x3270/x3270_files.mk': 'X3270_OBJECTS = Cme.o menubar.o Husk.o x3270.o\n',
      'Common/lib3270_files.mk': 'LIB3270_OBJECTS = kybd.o favicon.o\n',
      'Common/lib3270i_files.mk': 'LIB3270I_OBJECTS = scroll.o\n',
      'Common/lib32xx_files.mk': 'LIB32XX_OBJECTS = proxy.o\n',
    };
    expect(linkedSources((p: string) => files[p]!)).toEqual([
      'Common/favicon.c', 'Common/kybd.c', 'Common/proxy.c', 'Common/scroll.c',
      'x3270/menubar.c', 'x3270/x3270.c',
    ]);
  });

  it('guardsByLine tracks #if/#else/#endif nesting, with /*[*/ markers stripped', () => {
    const src = ['a', '#if defined(X) /*[*/', 'b', '#else /*][*/', 'c', '#endif /*]*/', 'd'].join('\n');
    const g = guardsByLine(src);
    expect(g[0]).toBeNull();
    expect(g[2]).toBe('defined(X)');
    expect(g[4]).toBe('!(defined(X))');
    expect(g[6]).toBeNull();
  });
});
