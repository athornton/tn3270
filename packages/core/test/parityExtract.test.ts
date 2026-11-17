import { describe, it, expect } from 'vitest';
import { extractNames, guardsByLine, linkedSources, makeVar, parseDefines } from '../../../scripts/parity-extract.mjs';

describe('parity-extract primitives', () => {
  it('makeVar joins continuation lines and strips .o', () => {
    const mk = '# c\nX3270_OBJECTS = a.o b.o \\\n\tc.o\nOTHER = z.o\n';
    expect(makeVar(mk, 'X3270_OBJECTS')).toEqual(['a', 'b', 'c']);
    expect(() => makeVar(mk, 'NOPE')).toThrow(/NOPE/);
  });

  it('makeVar also collects a `+=` continuation assignment', () => {
    const mk = 'X_OBJECTS = a.o b.o\nX_OBJECTS += c.o\n';
    expect(makeVar(mk, 'X_OBJECTS')).toEqual(['a', 'b', 'c']);
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

  it('parseDefines strips a multi-line /* */ comment and a // line comment, and joins a backslash continuation', () => {
    const d = parseDefines([
      '#define ResFoo /* a',
      'multi',
      'line comment */ "foo"',
      '#define ResBar "bar" // trailing comment',
      '#define ResBaz "baz"',
      '#define ResLong \\',
      '    "joined"',
    ].join('\n'));
    expect(d.get('ResFoo')).toBe('foo');
    expect(d.get('ResBar')).toBe('bar');
    expect(d.get('ResBaz')).toBe('baz'); // the line comment above must not eat this line too
    expect(d.get('ResLong')).toBe('joined');
  });

  it('parseDefines does not mistake "//" inside a string literal for a line comment', () => {
    // Real text, x3270/select.c: a naive `s.replace(/\/\/.*$/gm, '')` truncates this at the "//".
    const d = parseDefines('#define HTTP_PREFIX\t"http://"\n#define AFTER "still here"\n');
    expect(d.get('HTTP_PREFIX')).toBe('http://');
    expect(d.get('AFTER')).toBe('still here');
  });

  it('linkedSources: resolves each object through its group VPATH, adds the TLS module, excludes widgets, and lists missing objects', () => {
    const mk: Record<string, string> = {
      'x3270/x3270_files.mk': 'X3270_OBJECTS = Cme.o menubar.o Husk.o x3270.o\n',
      'Common/lib3270_files.mk': 'LIB3270_OBJECTS = kybd.o favicon.o find_console.o\n',
      'lib/3270/lib3270u_files.mk': 'LIB3270U_OBJECTS = print_command.o\n',
      'Common/lib3270i_files.mk': 'LIB3270I_OBJECTS = scroll.o\n',
      'Common/lib32xx_files.mk': 'LIB32XX_OBJECTS = proxy.o\n',
      'lib/32xx/lib32xxu_files.mk': 'LIB32XXU_OBJECTS = xpopen.o\n',
    };
    // Resolution order per group matters: find_console (lib3270u) and xpopen (lib32xxu) are
    // declared under lib/, but their `.c` is placed in Common/ here, as in the real tree;
    // print_command is placed in the lib's own dir ($(this)), to exercise that VPATH entry too.
    // favicon is in neither lib/3270, Common, nor Common/Nodisplay -> missingSources.
    const sourceFiles = new Set([
      'x3270/menubar.c', 'x3270/x3270.c',
      'Common/kybd.c', 'Common/find_console.c', 'lib/3270/print_command.c',
      'Common/scroll.c',
      'Common/proxy.c', 'lib/32xx/xpopen.c', 'Common/sio_openssl.c',
    ]);
    const read = (p: string) => {
      if (mk[p] !== undefined) return mk[p]!;
      if (sourceFiles.has(p)) return '';
      throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    };
    const out = linkedSources(read);
    expect(out.sources).toEqual([
      'Common/find_console.c', 'Common/kybd.c', 'Common/proxy.c', 'Common/scroll.c', 'Common/sio_openssl.c',
      'lib/3270/print_command.c', 'lib/32xx/xpopen.c',
      'x3270/menubar.c', 'x3270/x3270.c',
    ].sort());
    expect(out.missingSources).toEqual(['favicon']);
  });

  it('linkedSources rethrows a non-ENOENT read error instead of treating it as "not in this VPATH dir"', () => {
    const mk: Record<string, string> = {
      'x3270/x3270_files.mk': 'X3270_OBJECTS = x3270.o\n',
      'Common/lib3270_files.mk': 'LIB3270_OBJECTS =\n',
      'lib/3270/lib3270u_files.mk': 'LIB3270U_OBJECTS =\n',
      'Common/lib3270i_files.mk': 'LIB3270I_OBJECTS =\n',
      'Common/lib32xx_files.mk': 'LIB32XX_OBJECTS =\n',
      'lib/32xx/lib32xxu_files.mk': 'LIB32XXU_OBJECTS =\n',
    };
    const boom = Object.assign(new Error('boom'), { code: 'EACCES' });
    const read = (p: string) => {
      if (mk[p] !== undefined) return mk[p]!;
      if (p === 'x3270/x3270.c') throw boom;
      throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    };
    expect(() => linkedSources(read)).toThrow(boom);
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
    '#define OptV "-v"', '#define OptVersion "--version"', '#define OptEscape "-escape"',
    '#define ResKeypad "keypad"', '#define DotKeypad "." ResKeypad',
    '#define ResBroken UNRESOLVABLE_TOKEN',
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
    'struct option_help {',
    '    char *opt;',
    '    char *args;',
    '    char *help;',
    '} option_help[] = {',
    '    { OptV, NULL, "Display build options" },',
    '    { OptVersion, NULL, "Display build options" },',
    '    { OptEscape, NULL, "Say \\"hi" },',
    '};',
    '    if (argc == 2 && (!strcmp(argv[1], OptV) ||',
    '\t\t      !strcmp(argv[1], OptVersion))) {',
    '\tdump_version();',
    '    }',
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
    '    static bool toggle_init(Widget menu, int ix, const char *name1, const char *name2, bool *spaced);',
    '    toggle_init(t, TRACING, "traceOption", "traceOptionAlt", &spaced);',
    '    add_menu_itemv("printerOption", file_menu, do_printer, NULL, &spaced, "lu", NULL);',
    '    get_resource("proxy");',
    '    get_resource("extraResource");',
    '    y = DotKeypad;',
  ].join('\n'),
};
const read = (p: string) => {
  const t = TREE[p];
  if (t === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
  return t;
};
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
    // x3270/xactions.c (suite3270 4.5ga6) has 14 entries of the form `{ PA_PFX "Foo", ... }` plus
    // 2 bare `PA_END`/`PA_KEYMAP_TRACE` entries: 16 total. x3270's own internal event-handler
    // plumbing, not commands a user binds. Controller decision: these are not inventory names;
    // count them in `privateXactions` instead of listing or flagging them as unresolved.
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

  it('also takes options from option_help[], merging sites with base_options by id', () => {
    // OptV/OptVersion have no Xrm entry of their own (flag-only, checked by main() before any
    // option table), so each comes solely from option_help[] plus the strcmp scan below, merged.
    const v = out.names.find((n) => n.id === 'option:-v')!;
    expect(v).toBeDefined();
    expect(v.sites.map((s) => s.at)).toEqual(['x3270/x3270.c:14', 'x3270/x3270.c:18']);
    const version = out.names.find((n) => n.id === 'option:--version')!;
    expect(version.sites.map((s) => s.at)).toEqual(['x3270/x3270.c:15', 'x3270/x3270.c:19']);
  });

  it('parses an option_help entry whose help text has an escaped quote, without hanging', () => {
    // The regression target for the fields()/entries() lexer fix: `"Say \"hi\""` used to send
    // the old `String.indexOf('"', i)`-based scanner into an infinite loop.
    expect(ids).toContain('option:-escape');
  });

  it("also takes options x3270.c's main() matches by literal strcmp (OptV/OptVersion here)", () => {
    expect(out.names.find((n) => n.id === 'option:-v')!.sites.some((s) => s.at === 'x3270/x3270.c:18')).toBe(true);
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

  it('lists a resource referenced only through its Dot* name, never the bare Res* identifier', () => {
    expect(ids).toContain('resource:keypad');
  });

  it('flags a #define Res* whose value fails to parse, instead of silently dropping it', () => {
    expect(out.unresolved).toContain('ResBroken at include/resources.h:20');
  });

  it('collects get_resource("literal") names from linked x3270/ files, unless an option already sets that resource', () => {
    expect(ids).toContain('resource:extraResource');
    expect(ids).not.toContain('resource:proxy'); // get_resource("proxy") must not resurrect it
  });

  it('finds menu items, skipping spacers and non-menu widgets, and reports non-literal names', () => {
    expect(ids).toEqual(expect.arrayContaining(['menu:ftOption', 'menu:exitReallyOption', 'menu:monocaseOption']));
    expect(ids).not.toContain('menu:space');
    expect(ids).not.toContain('menu:label');
    expect(out.nonLiteralMenuCalls).toEqual(['x3270/menubar.c:8']);
  });

  it('skips a toggle_init prototype/definition line (its args start with a C type keyword)', () => {
    expect(ids).not.toContain('menu:menu'); // sanity: nothing spurious from the prototype line
    expect(out.nonLiteralMenuCalls).not.toContain('x3270/menubar.c:9');
  });

  it('takes every literal name from a toggle_init call that has two (name1 and name2)', () => {
    expect(ids).toContain('menu:traceOption');
    expect(ids).toContain('menu:traceOptionAlt');
  });

  it('does not pick a later literal argument of add_menu_itemv (only the first)', () => {
    expect(ids).toContain('menu:printerOption');
    expect(ids).not.toContain('menu:lu');
  });

  it('is sorted by id', () => {
    expect(ids).toEqual([...ids].sort());
  });
});
