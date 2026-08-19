# TUI Front End and 3279 Colour — Design

Design settled 2026-08-19. Two linked deliverables:

1. **Extended attributes in the core, far enough to do colour** — SA and SFE colour and
   highlighting stored per cell, plus a resolution layer that turns protocol attributes
   into concrete colours.
2. **`packages/tui`, a c3270 analog** — a curses-style terminal front end over the
   existing core, with terminfo-detected colour depth.

Programmable Symbol Sets are **out of scope** (the user's call). The cell model is
already a tagged variant so PS can be added later without touching consumers.

Prerequisite reading: the architecture and *GUI Design* sections of
`docs/superpowers/specs/2026-08-15-tn3270-client-design.md`, and `packages/core/src/
screen.ts` plus `stream/execute.ts`.

## Why a TUI, and why now

Three reasons, in order of weight:

1. **It is the only front end that can be run on the development box.** No X, no
   `DISPLAY`. Today the client can only be driven by scripts; a TUI makes it
   interactively usable by the developer *and* by the user on this machine.
2. **It proves the presentation contract with one real consumer before three depend on
   it.** The GUI and the web front end will both need "snapshot in, actions out". Design
   that boundary against a working consumer rather than against two hypothetical ones.
3. **It is cheap, because the core is already platform-free.** Verified, not assumed:
   `grep -rn "node:" packages/core/src/` returns **nothing**. All protocol work —
   telnet, data stream, screen, keyboard, OIA, fields, Query Reply, IND$FILE — is
   portable as-is, and the transport is already injected through the 5-member
   `Connection` interface (`session.ts:22-28`) precisely so tests and `Replay()` need no
   socket. A TUI reuses the Node TCP implementation from `cli/src/main.ts` unchanged.

**The web front end is deliberately NOT in this spec, but this design is what makes it
cheap.** The intended shape (the user's, clarified during design) is a small server that
owns the socket and serves JS to a browser — which is the *same process split as
Electron*, with WebSocket instead of IPC as the wire. A browser cannot open a raw TCP
socket, so `Connection` can never be satisfied browser-side; that is a deployment fact,
not a code-structure problem, and `Connection`/`TransferFiles` are exactly the two seams
where the swap happens. One presentation contract, three transports.

## THE MEASUREMENT THAT SETS THIS SCOPE

**ISPF is already sending us colour we throw away.** Counted through our own parser over
the committed TK5 fixture (`packages/fixtures/mvs/mvs-tk5-tso-ispf.trace`), all 113 SA
orders break down as:

| SA type | meaning | count |
|---|---|---|
| `0x42` | foreground colour | **101** |
| `0x00` | reset all character attributes to default | 12 |
| — | MF orders | 0 |

So colour is not speculative future-proofing for a hypothetical host. It is information
a host we test against every day is transmitting and we are discarding at
`execute.ts:363-366`. That is the whole justification for putting extended attributes in
this spec rather than deferring them again.

**Count it with the parser, never with a hex grep.** An earlier draft of this section
said 97, from `grep -oE "28 4[1235]"` over the trace text. That number was wrong in both
directions: a raw grep matches `28 42` occurring as SBA/RA address bytes or as payload
data, and it misses SA orders split across a continuation line. Reassembling the inbound
records and walking `parseRecord`'s deferred tokens gives 113/101/12. The grep also
completely hid the `0x00` resets, which matter — they are precisely the "return to
default" case rule 4 below has to handle, and a design that only saw `0x42` might have
skipped it.

**`0x00` as an SA type is not the same as `0x00` as a colour value.** As a type it means
"reset all character attributes to their defaults" (the manual: "The attribute type
`X'00'` is always supported by the SA order", `pages.txt:2991`); as a *value* under type
`0x42` it means "device default colour". Both appear in this fixture and conflating them
would be a real bug.

**What is already in place:** the parser fully decodes both carriers. SA arrives as
`{ kind: 'deferred', order: Order.SA, data }` with its 2-byte type/value payload
(`parse.ts:72`, `:245`), and SFE's pairs are parsed and the non-`0xC0` ones dropped with
a comment naming exactly what they are (`execute.ts:337-341`). **Nothing needs
re-parsing; the work is storage, resolution, and rendering.**

## Part 1 — Extended attributes in the core

### Storage: per-cell, following x3270's `struct ea`

`Cell` gains optional attribute members:

```ts
export type Cell = {
  kind: 'char';
  ebcdic: number;
  /** Foreground colour, a raw 3270 colour identification (0xF0-0xFF), or undefined. */
  fg?: number;
  /** Background colour, likewise. */
  bg?: number;
  /** Highlighting bits: blink, reverse, underscore. */
  gr?: number;
};
```

This is x3270's design, not an invention: `struct ea` at `include/globals.h:364-374`
carries `ec` (the EBCDIC code), `fa`, `fg`, `bg`, `gr` and `cs` **together, per cell**.
That structure is what decades of correct 3270 rendering has been built on.

**Honesty about the alternative, because our third reference implementation chose it:**
`tnz` uses **separate parallel planes** — `plane_dc`, `plane_fa`, `plane_eh`, `plane_cs`,
`plane_fg`, `plane_bg`, each a `bytearray(buffer_size)` (`tnz/tnz.py:210-215`). So
"per-cell struct" is x3270's choice, not a consensus. We follow x3270 here because our
`Cell` is already a tagged variant that consumers dispatch on (`screen.ts:18-21`, kept
that way for PS), so attributes belong on the thing that is already being handed out;
adding six parallel arrays to `snapshot()` would push the zip-them-together job onto
every consumer. Internally `Screen` still stores parallel typed arrays, matching its
existing `chars`/`attrs` layout — the struct exists at the snapshot boundary, which is
where consumers live.

`Screen` therefore grows three parallel typed arrays alongside `chars` and `attrs`, in
keeping with the existing "flat typed arrays, fields derived by scanning" decision that
the architecture section defends. **`undefined`/zero means "not set", which is
protocol-meaningful** — see the `0x00` rule below — so absence must be representable
rather than defaulted at storage time.

### Two carriers, and the precedence between them

| carrier | scope | order |
|---|---|---|
| **SFE** (and MF later) | the whole field it defines | `0x28`-family pairs on a field-defining order |
| **SA** | every character written *after* it, until the next SA or the end of the record | `0x28 type value` |

SA is **character-level running state during execution**, and the manual (p. 4-6,
`pages.txt:2969-2984`) specifies it exactly. Quoted, because three details here are easy
to get wrong and all three are testable:

> An SA order alters the set of character attribute type-value pairs to be applied to
> all subsequent characters until one of the following occurs: • A new SA order changes
> it. • **Another write type command is sent.** • **The Clear key is pressed.** • Power
> at the display is switched off. These four actions all return the established set of
> character attribute type-value pairs to their default value.

So `execute.ts` keeps a running SA state, applies it to each character it writes, and
resets it to defaults **at the start of every write command** — not per session, and not
per record-with-multiple-commands. x3270 does exactly this: `default_fg`/`default_bg`/
`default_gr` are zeroed at the top of write processing (`ctlr.c:1414-1416`, immediately
after the length check) and again on connect (`:410-412`).

**The Clear key is the fourth reset in the quoted list, and it is ours to implement on
the keyboard side** — a datastream reset will not cover it, because Clear originates
locally. Verified rather than assumed: x3270's two `default_*` reset sites are write
processing and connect, and Clear reaches the same state via `ctlr_clear` (`:552`,
`:1347`), so the reset must be wired into our `Clear` action explicitly. This is the
detail most likely to be missed.

Two further rules from the same pages, both of which the naive implementation gets wrong:

- **The composite rule** (`:2995-2997`): "The set of type-value pairs applied during
  character processing is a composite, by attribute type, of the last value specified in
  previously encountered SA orders." So SA state is a **per-type map**, not a single
  value — an SA setting colour does not clear a previously set highlighting. Modelling it
  as one value would silently drop attributes.
- **A plain SF resets extended attributes** (p. 4-4, `:2874-2875`): "If the display
  receives an SF order, it sets the associated extended field attribute to its default
  value." So `SF` is not attribute-neutral; it must clear the field's extended
  attributes, or a field following a coloured one inherits colour it was never given.
  Likewise **EW/EWA reset both extended field attributes and character attributes** of
  the cells they null (`:2988-2991`).

Field-level extended attributes from SFE are stored on the cells the field covers;
character-level SA overrides them for the characters it precedes. Where both are absent,
resolution falls through to the base field attribute (rule 2 below).

Attribute types to support (from `include/3270ds.h:240-255`, cross-checked against the
manual):

- `0x00` **reset** — returns every character attribute type to its default. Present in
  the TK5 fixture 12 times, so it is a live path, not a curiosity.
- `0x41` **highlighting** — `0x00` default, `0xF0` normal, `0xF1` blink, `0xF2` reverse,
  `0xF4` underscore, **`0xF8` intensify** (`3270ds.h:241-246`; do not stop at underscore
  — intensify is a fifth value and omitting it would silently render intensified text as
  plain)
- `0x42` **foreground colour**
- `0x45` **background colour**
- `0xC0` basic field attribute (already implemented)

Everything else — `0x43` character set, `0x46` transparency, `0xFE` input control —
stays parsed-and-dropped, and the existing `setAttributeIgnored` counter must keep
counting **only** what is still genuinely ignored, so a zero continues to mean "we never
saw one" rather than "we stopped looking".

### Resolution: a separate module, because two rules are protocol not preference

Storage answers "what did the host say". A renderer needs "what colour is this cell",
and that resolution is genuinely separate logic that must live in **exactly one place**
for the TUI, the GUI and the web front end. New module `packages/core/src/render.ts`:

```ts
export interface ResolvedCell {
  /** Unicode string for the cell, ' ' for null/unprintable. */
  text: string;
  /** Concrete 3279 palette entry, never undefined. */
  fg: Colour3279;
  bg: Colour3279;
  blink: boolean;
  reverse: boolean;
  underscore: boolean;
  /** Highlighting 0xF8. Distinct from the base attribute's intensified bit. */
  intensify: boolean;
  /** Hidden fields (FA intensity 0x0C) — renderers must not draw the text. */
  hidden: boolean;
}

export function resolve(snap: ScreenSnapshot, opts?: { mode3279?: boolean }): ResolvedCell[];
```

The rules it implements, each with its source:

1. **An explicit SA/SFE colour wins.**
2. **Absent that, colour derives from the base field attribute** — the 3279 default map:
   unprotected-normal → **green**, unprotected-intensified → **red**, protected-normal →
   **blue**, protected-intensified → **white**. This is x3270's `color_from_fa`
   (`Common/fprint_screen.c:78-95`), whose `field_colors[4]` table and `DEFCOLOR_MAP`
   bit-shuffle are exactly this mapping, and it matches what the project's own GUI
   section already committed to.
3. **`mode3279 == false` → everything is green.** x3270's same function returns
   `HOST_COLOR_GREEN` unconditionally when not in 3279 mode
   (`fprint_screen.c:91-94`). A 3278 is a monochrome device and must not be
   colourised just because the host sent an attribute.
4. **`0x00` means "device default", not black.** The manual: "The `X'00'` value selects
   the device default color indicated in the Query Reply (Color) structured field"
   (`pages.txt:3546-3548`). So `0x00` resolves through rule 2, never to a literal colour.
5. **`0xF7` means "colour comes from a triple-plane character set."** Same passage: with
   a single-plane or nonloadable character set "the color defaults to the single color
   specified for the `X'F7'` value by Query Reply (Color)" — i.e. white on a display.
   Since PS is out of scope, `0xF7` resolves to white and that is correct today.

**Rules 4 and 5 are why resolution cannot live in a front end.** They are datastream
semantics with citations, not rendering taste; reimplemented per front end they would
diverge three ways.

The 3279 palette itself (16 entries, `0xF0`-`0xFF` → RGB) is **core-side data**, because
the GUI needs the same RGB values for canvas fills. Names and codes from Table 4-7
(`pages.txt:3527-3541`): Neutral `F0`, Blue `F1`, Red `F2`, Pink `F3`, Green `F4`,
Turquoise `F5`, Yellow `F6`, Neutral-white `F7`, Black `F8`, Deep Blue `F9`, Orange
`FA`, Purple `FB`, Pale Green `FC`, Pale Turquoise `FD`, Grey `FE`, White `FF`.

**A BETTER PRIMARY SOURCE FOR THE CODES EXISTS, found during implementation
(2026-08-19): the same table is REPRINTED UNDAMAGED at `pages.txt:9244-9260`**, in
Chapter 6's Query Reply (Color) section (manual p. 6-37). It reads `Neutral X'F7'`,
`Black X'F8'` and `Purple X'FB'` correctly. Prefer it over Table 4-7 — though note it
comes through the same OCR pipeline over the same underlying table, so it is strong
corroboration rather than a fully independent document.

**THE RGB VALUES ARE OURS, NOT x3270's — and an earlier draft of this spec said
otherwise, wrongly.** x3270's actual default RGB table is `rgbmap[16]` at
`c3270/screen.c:213-229`, and it is a set of muted, named-CSS-style colours
(`neutral black 0x1a1a1a`, `blue 0x1e90ff` dodger blue, `green 0x32cd32` lime green,
`black 0x2f4f4f` dark slate grey — its own comment admits "alas, this may be gray").
**We use saturated primaries instead**, which is a deliberate presentation choice for a
device whose phosphors matched neither set, and the file must say so rather than
claiming a provenance it does not have.

Two consequences measured before committing to it:

- **All sixteen RGB values must be pairwise distinct.** Collapsing `neutral-black`
  (`F0`) with `black` (`F8`), or `neutral-white` (`F7`) with `white` (`FF`), loses
  information a host deliberately sent — x3270 keeps all sixteen visually distinct and
  so must we. A test asserting pairwise distinctness is worth more than the
  near-vacuous "every entry has three bytes in range" check, which TypeScript's tuple
  type already guarantees.
- **Saturated primaries survive 16-colour quantisation; x3270's palette does not.**
  With x3270's `rgbmap`, blue (`1e90ff`) and turquoise (`00ffff`) both quantise to ANSI
  96, collapsing two of the seven base colours. With saturated primaries all seven stay
  distinct at 16 **and** 256. That is the concrete reason to keep our own values, and
  it is why the quantisation tests can assert seven-distinct at all.

**BEWARE THE OCR IN THAT TABLE — it is damaged in two places and must not be
transcribed literally.** It renders F7 as `X'F?'`, and it prints **`X'FB'` twice**, for
both Black and Purple. The correct values are Black `0xF8` and Purple `0xFB`; F8 is
confirmed by the sequence being contiguous `F0`-`FF` and by x3270's own colour table.
Verify every one of these 16 against `include/3270ds.h` before committing the table —
this is precisely the failure mode `verify-wire-constants-against-sources` exists for.

### Advertising it, or the host will not send it

A well-behaved host sends extended attributes only to a client that says it has them.
x3270 answers Query Reply **Color (`0x86`)** and **Highlighting (`0x87`)**
(`Common/sf.c:73`, `:86`; `do_qr_color` at `:735-763` reports 16 colours). Our
`queryreply.ts` is built from a capability list expressly so "advertising something later
is one list entry", so this is two new units, not a refactor.

**But note what the TK5 measurement above proves: TSO is already sending SA colour
without our advertising anything.** So the two units are for correctness with
better-behaved hosts, not a prerequisite for seeing colour on TK5 — and that asymmetry
should be recorded as a live finding when it is confirmed on the wire, not assumed
either way.

## Part 2 — `packages/tui`

### Shape

A new workspace package depending on `@tn3270/core` only. No curses binding, no
`blessed`: the render surface is a 24×80 (or 27×132) character grid plus one status
line, drawn with raw ANSI escapes to stdout, which is a few hundred lines and avoids a
native dependency in a project whose stated policy is "no deps beyond `node:net` and
`node:tls`".

```
packages/tui/src/
  main.ts        argv, TERM detection, raw-mode setup and teardown
  colours.ts     3279 palette -> ANSI, quantised per detected depth
  render.ts      ResolvedCell[] -> ANSI, dirty-cell diffing
  keymap.ts      terminal key sequences -> core Keyboard actions
  app.ts         wires Session events to render; owns the run loop
```

### Colour depth: detect, never assume

Four tiers, chosen from the terminal's actual capability:

| detected | behaviour |
|---|---|
| 24-bit | exact 3279 RGB via `38;2;r;g;b` |
| 256 | nearest entry in the xterm 6×6×6 cube |
| 8/16 | the standard ANSI mapping, where the 3279's seven core colours naturally live |
| monochrome / none | ignore colour; render highlighting with reverse and intensity only |

**Detection is `tput -T$TERM colors`, shelled out — not a library and not Node's
builtin.** Measured on the dev box, all three approaches against the same terminals:

| terminal | `tput` | Node `getColorDepth` | truth |
|---|---|---|---|
| `xterm-256color` | 256 | 8 | 256 |
| `screen-256color` | 256 | **16** ✗ | 256 |
| `xterm-direct` | **16777216** | **16** ✗ | 24-bit |
| `xterm` | 8 | 16 | 8 |
| `vt100` | -1 | 16 ✗ | none |
| unknown | -1 (clean fail) | — | — |

Node's `tty.WriteStream.getColorDepth` is `TERM`-string heuristics, not terminfo, and it
is wrong in exactly the cases this feature exists to detect — anything under GNU screen
loses colour, and a direct-colour terminal is capped at 16. The `terminfo` npm package
does parse the binary database, but it is v0.1.1, last published 2016, one maintainer:
not a dependency worth taking. `tput` is POSIX, ships with the terminfo database it
reads, and is at `/usr/bin/tput` here.

Three refinements, each of which is a real case:

1. **`COLORTERM=truecolor` overrides terminfo upward.** Many 24-bit terminals still
   advertise `TERM=xterm-256color`; terminfo alone would cap them at 256. Take the
   maximum of the two signals.
2. **`tput` may be absent** (minimal container, Windows). Fall back to
   `getColorDepth`, then to monochrome. A missing binary must never be fatal.
3. **`--colors 0|8|16|256|16m` forces it.** Detection is a default, not a verdict:
   terminfo entries are sometimes conservative, and the monochrome path needs to be
   testable on a colour terminal.

### Keyboard

The core already owns 3270 *actions* — `Keyboard` handles field-aware typing, tab,
EraseEOF, insert mode, and the lock rules, and `Wait(Unlock)` and the enter-inhibit work
are already enforced there. So `keymap.ts` translates terminal input to those calls and
implements no 3270 semantics of its own.

Defaults follow c3270: F1-F12 → PF1-12, Escape-prefixed or Shift variants → PF13-24,
Return → Enter, Tab/Shift-Tab → field navigation, Ctrl-U → erase input, Ctrl-C → the
`Clear` AID (**not** SIGINT — raw mode must intercept it, and there must be a documented
way out, `Ctrl-]` by convention).

**The known hazard, from experience already recorded in the GUI section:** terminals
deliver PF keys as multi-byte escape sequences that vary by terminal, and an escape
prefix is ambiguous with a lone Escape until a timeout resolves it. Parse sequences from
terminfo where possible rather than hardcoding xterm's, and give the keymap a config
file as the GUI's does.

### Status line

The OIA is drawn on a 25th row and comes from `oia.toText()`, which already exists and
is already what the CLI and tests consume. No new status logic.

### Fonts are the GUI's problem, not the TUI's

**The TUI must not try to load or bundle a font.** It draws into whatever terminal the
user already has, with whatever font that terminal is configured to use; there is no
hook for a client to change it and attempting one would be both futile and rude.

The main design doc commits to bundling **3270font**
(https://github.com/rbanffy/3270font) for the **GUI** — licence checked during design:
BSD 3-Clause with the SFD source additionally under OFL 1.1, so bundling is permitted
provided the copyright notice ships. For the TUI, that is *advice to the user* rather
than a dependency, and it belongs in the README: a user who wants the authentic look
installs 3270font locally and points their terminal at it. Nothing in `packages/tui`
should reference it in code.

**One TUI-specific consequence worth stating, because it is invisible until it bites:**
the 3270 character set includes glyphs a modern terminal font may lack, and a missing
glyph renders as a replacement box that silently corrupts the screen a user is reading.
The renderer cannot detect this — it emits a code point and the terminal decides. So
when the code page grows beyond CP037, or when Programmable Symbol Sets eventually land
(out of scope here), the honest answer for a terminal front end is that some cells may
be unrepresentable, and that limit should be documented rather than papered over.

## Error handling

- **Terminal too small** for the negotiated screen: say so and refuse to draw a
  misleading partial screen, the way `Transfer()` refuses a non-24×80 geometry rather
  than guessing.
- **Raw mode must be restored on every exit path** — normal quit, `Ctrl-]`, an uncaught
  exception, and SIGTERM. A TUI that dies leaving the terminal in raw mode with no echo
  is the single most user-hostile failure available here.
- **Resolution must never throw on a malformed attribute.** An unknown colour value
  resolves through the default map with a trace note; a bad attribute from a host must
  not take the client down, matching how the codebase treats program checks as reportable
  rather than fatal.

## Testing

The existing discipline applies: unit tests against synthetic screens, then a live host.

1. **Resolution is pure and exhaustively testable** — `resolve()` over all four base
   attribute combinations × explicit/absent/`0x00`/`0xF7` colour, in both `mode3279`
   states. Rules 3, 4 and 5 each get a test that fails if the rule is dropped.
2. **Quantisation is pure** — the 16 palette entries at each of the four depths, pinned
   as byte strings. This is where a wrong table shows up immediately.
3. **SA running state**, one test per rule in the quoted passage, because this is where
   this design is most likely to ship a bug: that it applies to characters after it and
   not before; that it is a **per-type composite** (an SA colour does not clear an SA
   highlighting); that it **resets at each write command**; that **Clear resets it**;
   that **plain SF clears a field's extended attributes**; and that **EW/EWA clear both**
   for the cells they null. Each rule gets a test that fails if the rule is removed.
4. **The TK5 fixture is the regression corpus, and it is already on disk.** Replaying
   `mvs-tk5-tso-ispf.trace` must produce coloured output; 101 foreground SA orders and 12
   resets mean the ISPF panel has known colour structure to assert against. **This is the
   test that would have caught the whole gap**, and it needs no host. Pin the counts
   (113/101/12) as a test too, so a parser regression that stops recognising SA shows up
   as a failure rather than as a quietly monochrome screen.
5. **Live: drive a real ISPF session in the TUI and look at it.** Screenshot-equivalent
   is a `ScreenJson` dump plus the resolved colours, diffable against a `zti` run for
   the same panel. `zti` is on disk at `~/git/tnz`, renders colour normally inside any
   colour-capable terminal, and is therefore the reference for colour the way s3270 was
   for the datastream.

   **The hazard is in the capture method, not in `zti`.** Its colour gate is
   `self.colors >= 8 and sys.stdin.isatty()` (`tnz/tnz.py:251-253`), and `self.colors`
   defaults to **768** (`:94`, overridable via `TNZ_COLORS`), so the `>= 8` half is
   satisfied out of the box and `isatty()` is the only thing that can fail. Piping a
   `zti` run's stdout to a file makes it false, silently producing a colourless capture
   that would "prove" we emit too much colour. Capture through a pty — `script`, as the
   2026-08-17 session did — or the comparison is worthless. Same class of mistake as the
   negative-control probe that reported an absence it could not have detected.

   **`zti` is a reference for WHICH colour, not for quantisation.** It has no depth
   tiering: `tnz.py` consults no terminfo, and `zti.py` reduces everything to a boolean
   `min(tns.colors, self.colors) >= 8` (`zti.py:1560`, `:3134`, `:3180`). So our
   16/256/24-bit ladder has no reference implementation to diff against and its tests
   must be self-contained — which is what test 2 above is for.

**Mutation-test the resolution rules.** Review on the stage 2a work found two tests that
passed with the behaviour they claimed to pin deleted; the colour rules are exactly the
shape of thing where an assertion can look right and pin nothing.

## Scope boundary

**In:** per-cell fg/bg/highlighting storage; SA and SFE colour and highlighting; the
resolution module and the 3279 palette; Color and Highlighting Query Reply units;
`packages/tui` with terminfo-detected colour, keymap, OIA and raw-mode safety.

**Out:** Programmable Symbol Sets (`0x43` character set stays dropped); MF colour
(`modifyFieldIgnored` keeps counting); the web front end and its server; the Electron
GUI; mouse support; alternate geometry beyond what the core already negotiates.

**Not assumed:** that any of this is conformant on a modern host. Everything here is
verified against VM/370 and MVS 3.8j only — see the *Test hosts* section of the main
design doc, and expect colour behaviour to be one of the things a future z/OS run
checks first.
