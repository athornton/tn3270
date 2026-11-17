import { describe, it, expect } from 'vitest';
import { extractNames, guardsByLine, linkedSources, makeVar, parseDefines } from '../../../scripts/parity-extract.mjs';

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

const TREE: Record<string, string> = {
  'include/names.h': '#define AnAttn "Attn"\n#define AnStepEfont "StepEfont"\n#define AnMonoCase "MonoCase"\n',
  'include/resources.h': [
    '#define ResProxy "proxy"', '#define DotProxy "." ResProxy', '#define OptProxy "-proxy"',
    '#define ResModel "model"', '#define DotModel "." ResModel', '#define OptModel "-model"',
    '#define ResMonoCase "monoCase"', '#define ResHostsFile "hostsFile"', '#define ResUnused "unused"',
    '#define OptOnlyXrm "-onlyxrm"', '#define ResOnlyXrm "onlyXrm"', '#define DotOnlyXrm "." ResOnlyXrm',
    '#define OptGlueOnly "-glueonly"', '#define ResGlueOnly "glueOnly"',
  ].join('\n'),
  'Common/kybd.c': [
    '#define RESUME_INPUT "ResumeInput"',
    'static action_table_t kybd_actions[] = {',
    '    { AnAttn,\t\tAttn_action,\t\tACTION_KE },',
    '    { AnMonoCase,\tMonoCase_action,\tACTION_KE | ACTION_HIDDEN },',
    '    { RESUME_INPUT,\tResumeInput_action, 0 },',
    '};',
    'x = ResHostsFile;',
  ].join('\n'),
  'Common/glue.c': [
    'static opt_t base_opts[] = {',
    '{ OptProxy,  OPT_STRING, false, ResProxy, aoffset(proxy),',
    '    "<host>", "Proxy" },',
    '{ OptGlueOnly, OPT_STRING, false, ResGlueOnly, aoffset(g), NULL, NULL },',
    '};',
  ].join('\n'),
  'Common/toggles.c': 'toggle_name_t toggle_names[] = {\n    { ResMonoCase,        MONOCASE,\t\tfalse },\n    { NULL, 0, false }\n};\n',
  'x3270/x3270.c': [
    'XrmOptionDescRec base_options[]= {',
    '    { OptProxy,\tDotProxy,\tXrmoptionSepArg,\tNULL },',
    '    { OptOnlyXrm,\tDotOnlyXrm,\tXrmoptionNoArg,\tResTrue },',
    '#if defined(X) /*[*/',
    '    { OptModel,\tDotModel,\tXrmoptionSepArg,\tNULL },',
    '#endif /*]*/',
    '    { OptClear,\t".xxx",\tXrmoptionSkipArg,\tNULL },',
    '};',
  ].join('\n'),
  'x3270/xactions.c': [
    'static XtActionsRec xactions[] = {',
    '    { "Cut",\t\tCut_xaction },',
    '    { AnStepEfont,\tStepEfont_xaction },',
    '    { PA_PFX "ConfigureNotify",\tPA_ConfigureNotify_xaction },',
    '};',
  ].join('\n'),
  'x3270/menubar.c': [
    '    w = add_menu_itemv("ftOption", file_menu,',
    '\t    popup_ft, NULL, &spaced, NULL);',
    '    XtVaCreateManagedWidget("space", cmeLineObjectClass, m, NULL);',
    '    w = XtVaCreateManagedWidget(',
    '\t"exitReallyOption", cmeBSBObjectClass, exit_menu, NULL);',
    '    XtVaCreateManagedWidget("label", labelWidgetClass, m, NULL);',
    '    toggle_init(t, MONOCASE, "monocaseOption", NULL, &spaced);',
    '    add_menu_itemv(host_name, m, cb, NULL, NULL, NULL);',
  ].join('\n'),
};
const read = (p: string) => { const t = TREE[p]; if (t === undefined) throw new Error(`ENOENT ${p}`); return t; };
const FILES = ['Common/glue.c', 'Common/kybd.c', 'Common/toggles.c', 'x3270/menubar.c', 'x3270/x3270.c', 'x3270/xactions.c'];

describe('extractNames', () => {
  const out = extractNames(read, FILES);
  const ids = out.names.map((n) => n.id);

  it('finds actions (An*, or a define local to the file), leaving out ACTION_HIDDEN', () => {
    expect(ids).toEqual(expect.arrayContaining(['action:Attn', 'action:ResumeInput']));
    expect(ids).not.toContain('action:MonoCase');
    expect(out.names.find((n) => n.id === 'action:Attn')!.sites).toEqual([{ at: 'Common/kybd.c:3', guard: null }]);
  });

  it('finds the pure Xt actions of xactions[] as xaction:, literal or An*', () => {
    expect(ids).toEqual(expect.arrayContaining(['xaction:Cut', 'xaction:StepEfont']));
  });

  it('excludes PA_-prefixed private Xt actions (x3270 event handlers, not user-bindable), counted', () => {
    // x3270/xactions.c (suite3270 4.5ga6) has 13 entries of the form `{ PA_PFX "Foo", ... }` plus
    // bare `PA_END`/`PA_KEYMAP_TRACE` entries: x3270's own internal event-handler plumbing, not
    // commands a user binds. Controller decision: these are not inventory names; count them in
    // `privateXactions` instead of listing or flagging them as unresolved.
    expect(ids).not.toContain('xaction:PA_PFXConfigureNotify');
    expect(out.unresolved).not.toContain('PA_PFX "ConfigureNotify" at x3270/xactions.c:4');
    expect(out.privateXactions).toBe(1);
  });

  it("takes options from x3270's Xrm table only, with the resource each sets", () => {
    const proxy = out.names.find((n) => n.id === 'option:-proxy')!;
    expect(proxy.resource).toBe('proxy');
    expect(proxy.sites.map((s) => s.at)).toEqual(['x3270/x3270.c:2']);
    expect(out.names.find((n) => n.id === 'option:-onlyxrm')!.resource).toBe('onlyXrm');
    expect(out.names.find((n) => n.id === 'option:-model')!.sites[0]!.guard).toBe('defined(X)');
  });

  it("ignores opt_t tables (x3270's register_opts is a no-op), so their resource is a plain resource", () => {
    expect(ids).not.toContain('option:-glueonly');
    expect(ids).toContain('resource:glueOnly');
  });

  it('keeps an option whose define is unknown, under its identifier, and flags it', () => {
    expect(ids).toContain('option:OptClear');
    expect(out.unresolved).toContain('OptClear at x3270/x3270.c:7');
  });

  it('finds toggles from toggle_names[]', () => {
    expect(ids).toContain('toggle:monoCase');
  });

  it('lists a resource only when used and not set by an option or a toggle', () => {
    expect(ids).toContain('resource:hostsFile');
    for (const gone of ['resource:proxy', 'resource:model', 'resource:onlyXrm', 'resource:monoCase', 'resource:unused']) {
      expect(ids).not.toContain(gone);
    }
  });

  it('finds menu items, skipping spacers and non-menu widgets, and reports non-literal names', () => {
    expect(ids).toEqual(expect.arrayContaining(['menu:ftOption', 'menu:exitReallyOption', 'menu:monocaseOption']));
    expect(ids).not.toContain('menu:space');
    expect(ids).not.toContain('menu:label');
    expect(out.nonLiteralMenuCalls).toEqual(['x3270/menubar.c:8']);
  });

  it('is sorted by id', () => {
    expect(ids).toEqual([...ids].sort());
  });
});
