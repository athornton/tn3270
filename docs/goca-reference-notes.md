# GOCA drawing orders — extracted reference notes

**Purpose.** `docs/HANDOFF.md` records that the 3270 Programmer's Reference defines the *envelope*
for native vector graphics (`Object Control X'0F11'`, `Object Data X'0F0F'`, `Object Picture
X'0F10'`) and then defers byte 7–n to "the appropriate graphics or image publications". This file
records what those publications say, so the next session does not re-derive it.

**Source.** `$HOME/S544-5498-01_GOCA_for_AFP_Reference_Oct2000.pdf` — *Graphics Object Content
Architecture for Advanced Function Presentation Reference*, S544-5498-01, October 2000, 216 pages.
Supplied by the user 2026-09-25. Text extracts cleanly with `pypdf` (see *Tooling* below).
**THREE MORE SOURCES HAVE SINCE ARRIVED and this is no longer the only one** — j3270 (2026-09-25),
and the HOD support matrix plus a 3192G ROM disassembly (2026-09-28). Sections below, in date order.

**STATUS: nothing here has been checked against a terminal we have driven, or a byte on a wire we
have sent.** Read the caveat section before designing against it. **But the claim is now narrower
than "a paper exercise" (corrected 2026-09-28):** the sources include a **3192G ROM disassembly** and
IBM's own emulator support matrix, so parts of this file describe measured firmware behaviour rather
than a specification's intent. That is still not a live witness — it says what the device would do,
not that we have made it do anything. **Per-claim provenance is what matters; see the 2026-09-28
section, and blueglass's own markers.**

---

## THE CAVEAT THAT MATTERS MOST: THIS IS THE *AFP* EDITION

GOCA is one architecture with several environment bindings. **This book is bound to MO:DCA and
IPDS — printers.** Its own introduction lists the "strategic presentation data stream
architectures" as MO:DCA and IPDS; the 3270 data stream is mentioned exactly **once** in 216 pages
(p. idx19, in a list of data streams), and no 3179, 3192 or 3472 appears anywhere.

Concretely, the book carries **Appendix A: Compliance with MO:DCA Interchange Sets** and
**Appendix B: IPDS Graphics Command Set**, and there is **no 3270 appendix**. It also defines an
**Extended order format** and then says it "is not used in AFP GOCA" — an explicit statement that
*this binding* is a subset of the architecture, which is direct evidence that bindings differ.

**So the drawing orders below are very likely the right primitives, and the subset, defaults and
environment controls are NOT yet established for a 3270 terminal.** The unresolved question is not
"what is a Line order" but "which orders does a 3179-G accept, with what defaults, inside
`Object Picture`". The user notes they have not yet found 3179-G/3192-G manuals; **those are still
the missing piece, and this book does not replace them.**

---

## Order formats — self-describing from the opcode

The single most useful structural fact, because it means a decoder needs **no per-order length
table** to walk the stream (p. idx77–78):

> Drawing orders are represented in one of four formats, depending on the length of the operand
> data: Fixed 1-byte … Fixed 2-byte … Long … Extended (not used in AFP GOCA).
>
> The format of an order is determined by its order code:
> - One fixed 1-byte order has an order code of `X'00'`.
> - For fixed 2-byte orders, bit 0 is set to 0, and bit 4 is set to 1, that is, the first digit of
>   the order code is less than 8, and the second digit is greater than, or equal to, 8.
> - Apart from the special orders … orders that are not fixed 2-byte orders are long format orders.
> - Extended orders have an order code of `X'FE'`.

| format | shape | operand capacity |
|---|---|---|
| fixed 1-byte | `code` | none |
| fixed 2-byte | `code operand` | exactly 1 byte |
| long | `code length operand…` | ≤ 255 bytes |
| extended | `X'FE' qualifier len16 operand…` | ≤ 65535, **unused in AFP GOCA** |

**The length field excludes the order code and the length field itself** — stated for both long and
extended format. That is the same convention as a DFT frame's data length and the *opposite* of a
3270 structured field's `L`, which counts itself. Worth pinning in a test when this is built, since
three adjacent length conventions in one codebase is exactly how an off-by-two ships.

**MECHANICALLY VERIFIED, 2026-09-25:** the rule was applied to all 49 orders in Table 16 and
cross-checked against four order definitions read individually. It classifies every order
consistently with its own offset table (`GNOP1 X'00'` → 1-byte; `GSLT X'18'` → 2-byte, one operand
byte carrying the line type; `GSCP X'21'` → long, it needs coordinates; `GEAR X'60'` → long with a
length byte, confirmed at p. idx94; `GBIMG X'D1'` → long, and the manual's own example shows
`LENGTH = X'0A'`).

**Two orders violate the rule, and the manual flags both as not really GOCA:** `X'43'` Set Pick
Identifier and `X'71'` End Segment, each documented as "not formally part of AFP GOCA, but accepted
by some AFP printers and treated as a No-Op". `X'71'` is called a *fixed two-byte* order while the
bit rule predicts long format. **Treat both as No-Ops and do not use either to infer the format
rule.**

## The "at current position" / "at given position" pairing

Most primitives exist twice, and the pair differs by **bit 1** (`0x40`): the *given position* form
carries an explicit starting coordinate, the *at current position* form starts from current
position.

| primitive | at CP | given position | acronyms |
|---|---|---|---|
| Box | `X'80'` | `X'C0'` | GCBOX / GBOX |
| Line | `X'81'` | `X'C1'` | GCLINE / GLINE |
| Marker | `X'82'` | `X'C2'` | GCMRK / GMRK |
| Character String | `X'83'` | `X'C3'` | GCCHST / GCHST |
| Fillet | `X'85'` | `X'C5'` | GCFLT / GFLT |
| Full Arc | `X'87'` | `X'C7'` | GCFARC / GFARC |
| Begin Image | `X'91'` | `X'D1'` | GCBIMG / GBIMG |
| Relative Line | `X'A1'` | `X'E1'` | GCRLINE / GRLINE |
| Partial Arc | `X'A3'` | `X'E3'` | GCPARC / GPARC |

**Do not implement this as a bit test without checking it against the subset actually accepted.**
The pairing is a real regularity in the table, but `X'92'` (Image Data) and `X'93'` (End Image)
break it — they have no `0xD2`/`0xD3` partner — so a decoder driven by "clear bit 1 to get the
primitive" would invent two orders that do not exist.

## Table 16 — drawing orders sorted by identifier (complete, p. idx178–180)

Page numbers are the book's own.

### Attributes and controls
| code | name | acronym | p. | format |
|---|---|---|---|---|
| `X'00'` | No Operation | GNOP1 | 89 | fixed 1 |
| `X'01'` | Comment | GCOMT | 76 | long |
| `X'04'` | Segment Characteristics | GSGCH | 95 | long |
| `X'08'` | Set Pattern Set | GSPS | 126 | fixed 2 |
| `X'0A'` | Set Color | GSCOL | 111 | fixed 2 |
| `X'0C'` | Set Mix | GSMX | 125 | fixed 2 |
| `X'0D'` | Set Background Mix | GSBMX | 98 | fixed 2 |
| `X'11'` | Set Fractional Line Width | GSFLW | 117 | long |
| `X'18'` | Set Line Type | GSLT | 118 | fixed 2 |
| `X'19'` | Set Line Width | GSLW | 119 | fixed 2 |
| `X'21'` | Set Current Position | GSCP | 113 | long |
| `X'22'` | Set Arc Parameters | GSAP | 96 | long |
| `X'26'` | Set Extended Color | GSECOL | 114 | long |
| `X'28'` | Set Pattern Symbol | GSPT | 127 | fixed 2 |
| `X'29'` | Set Marker Symbol | GSMT | 124 | fixed 2 |
| `X'33'` | Set Character Cell | GSCC | 102 | long |
| `X'34'` | Set Character Angle | GSCA | 100 | long |
| `X'35'` | Set Character Shear | GSCH | 110 | long |
| `X'37'` | Set Marker Cell | GSMC | 120 | long |
| `X'38'` | Set Character Set | GSCS | 108 | fixed 2 |
| `X'39'` | Set Character Precision | GSCR | 106 | fixed 2 |
| `X'3A'` | Set Character Direction | GSCD | 104 | fixed 2 |
| `X'3B'` | Set Marker Precision | GSMP | 121 | fixed 2 |
| `X'3C'` | Set Marker Set | GSMS | 123 | fixed 2 |
| `X'3E'` | End Prolog | GEPROL | 79 | fixed 2 |
| `X'43'` | Set Pick Identifier | GSPIK | — | **not GOCA; No-Op** |
| `X'60'` | End Area | GEAR | 77 | long |
| `X'68'` | Begin Area | GBAR | 65 | fixed 2 |
| `X'71'` | End Segment | — | — | **not GOCA; No-Op** |
| `X'B2'` | Set Process Color | GSPCOL | 128 | long |

### Primitives
| code | name | acronym | p. |
|---|---|---|---|
| `X'80'` / `X'C0'` | Box at CP / Box | GCBOX / GBOX | 72 / 71 |
| `X'81'` / `X'C1'` | Line at CP / Line | GCLINE / GLINE | 85 |
| `X'82'` / `X'C2'` | Marker at CP / Marker | GCMRK / GMRK | 87 |
| `X'83'` / `X'C3'` | Character String at CP / Character String | GCCHST / GCHST | 74 |
| `X'85'` / `X'C5'` | Fillet at CP / Fillet | GCFLT / GFLT | 80 |
| `X'87'` / `X'C7'` | Full Arc at CP / Full Arc | GCFARC / GFARC | 82 |
| `X'91'` / `X'D1'` | Begin Image at CP / Begin Image | GCBIMG / GBIMG | 67 |
| `X'92'` | Image Data | GIMD | 84 |
| `X'93'` | End Image | GEIMG | 78 |
| `X'A1'` / `X'E1'` | Relative Line at CP / Relative Line | GCRLINE / GRLINE | 93 |
| `X'A3'` / `X'E3'` | Partial Arc at CP / Partial Arc | GCPARC / GPARC | 90 |

**Commands and control instructions are separate, tiny tables** (p. idx178): exactly one command,
`Begin Segment (BSI) X'70'`, and exactly one control instruction, `Set Current Defaults (SCD)
X'21'`. Note `X'21'` is **both** SCD as a control instruction and GSCP as a drawing order — they
live in different namespaces, so a decoder must know which stream it is in. That is a trap.

## Set Line Type operands (p. idx49)

`X'00'` drawing default · `X'01'` dotted · `X'02'` short dashed · `X'03'` dash-dot ·
`X'04'` double dotted · `X'05'` long dashed · `X'06'` dash double-dot · `X'07'` solid ·
`X'08'` invisible.

**`X'00'` is "drawing default", not solid, and solid is `X'07'`** — the kind of off-by-default that
would make every line render wrong in a way that looks like a coordinate bug. With invisible,
"current position is updated, but nothing is drawn".

## Worked example the manual supplies — GBIMG (p. idx6)

Useful as a first decoder test vector, since it shows the long format concretely:

| offset | type | name | value | meaning |
|---|---|---|---|---|
| 0 | CODE | — | `X'D1'` | GBIMG order code |
| 1 | UBIN | LENGTH | `X'0A'` | length of following data |
| 2–3 | SBIN | XPOS | `X'8000'`–`X'7FFF'` | Xg of image origin |
| 4–5 | SBIN | YPOS | `X'8000'`–`X'7FFF'` | Yg of image origin |
| 6 | CODE | FORMAT | `X'00'` | each image point → one device pel |
| 7 | RES | — | `X'00'` | reserved, only valid value |
| 8–9 | UBIN | WIDTH | `X'0000'`–`X'FFFF'` | width in image points |
| 10–11 | UBIN | HEIGHT | `X'0000'`–`X'FFFF'` | height in scan lines |

**Coordinates are SBIN — signed, 16-bit, big-endian, range `X'8000'`–`X'7FFF'`.** Our
`address.ts` already handles 14-bit 3270 buffer addressing; this is a different and simpler
encoding, and conflating the two would be easy.

## Other facts worth not re-deriving

- **Picture lives in a Graphics Presentation Space (GPS)**, "independent" of the device — so there
  is a coordinate transform between GPS and pels, and the drawing orders are resolution
  independent. Chapter 4 covers primitives, attributes and current position; chapter 5 segments;
  chapter 6 environment controls.
- **Five primitive classes:** lines, areas, character strings, markers, images.
- **Two line primitive types** (straight and curved), with line type *not* reset except by a
  "Move Type order" — any order that explicitly sets current position before drawing (Table 5).
- **Symbols are shared machinery**: characters, markers and shading patterns are all drawn from
  symbol sets, each with Set-*-Set / Set-*-Symbol orders. This is the natural seam to PS, and
  Table 3 lists which attribute orders apply to character vs marker vs pattern symbols.
- **Exception codes** are `EC-xxxx` for drawing process checks (p. 136) and `CPC-xxxx` for
  communication process checks. e.g. `EC-0002` reserved byte not zero; `EC-6000` End Area with no
  matching Begin Area. A conformant implementation is expected to raise these, which is a source of
  negative test cases.

## GA23-0059-07 in better form, and the two books we still need (2026-09-25)

The user supplied two copies of the 3270 Programmer's Reference:

- `$HOME/GA23-0059-07_3270_Data_Stream_Programmers_Reference_199206.pdf` — the released June 1992
  document, 26 MB (scanned).
- `$HOME/GA23-0059-07-text.pdf` — **a near-all-text draft, 471 pages, and the one to use.** It
  extracts with proper table borders and renders hex as `X’0F10’` with real typographic quotes.

**It is the SAME EDITION as `~/3270/ref/pages.txt`** (which is also GA23-0059-07), so it adds no new
*content* — but it is materially better for citation, because `pages.txt` mangles `X'nn'` into
`X }nn}` and loses table structure. **Prefer the draft PDF for any new structured-field work**; keep
`pages.txt` line citations already in the code, since they are what existing comments reference.

**It does NOT close the graphics gap, confirmed by search:**
- The graphics `DATA` deferral appears in **seven** places, not one.
- **Zero GOCA drawing orders appear anywhere in 471 pages** — searched for `GLINE`, `GSCP`, `GBIMG`,
  `GCHST`, `GFARC`, `GSLT`, `GSCOL`, `GBAR`, `GEAR`, `GNOP1`. The 3270 manual and GOCA do not overlap
  at all; the envelope and the contents live in genuinely separate books.

**BUT IT NAMES THE TWO BOOKS WE ACTUALLY NEED (p. idx11, the related-publications list):**

| order number | title |
|---|---|
| **GA18-2177** | *IBM 3179 Color Display Station Description* |
| **GA18-2535** | *IBM 3192 Display Station Description* |

**These are the acquisition targets now.** They are the terminal-specific descriptions, so they are
where the 3270 GOCA subset, the device defaults, and the pel geometry should live — the three things
GOCA-for-AFP cannot tell us. The only other mention of these terminals is at idx432, listing the
3179 among devices that "interpret the data stream", which adds nothing.

## A SECOND INDEPENDENT IMPLEMENTATION: j3270 (2026-09-25)

<https://git.hugfreevikings.wtf/rudi/j3270> — an x3270-aligned 3270 emulator and protocol library in
pure Java, **Unlicense (public domain)**, 511 Java files, 6.4 MB. Supplied by the user. It has a
working GOCA implementation with its own test suite:
`lib3270j/src/main/java/haus/nightmare/lib3270j/graphics/` — `GocaConstants.java`, `GocaDecoder.java`,
`GraphicsPlane.java`, `HODGraphicsPlane.java`, `VectorSymbolData.java`, plus five Goca test classes.

### It corroborates our extraction strongly

**43 opcodes agree exactly** between its `GocaConstants.java` and our Table 16 extraction, on every
code the two share. Two independent readings, from **different sources**, matching — that is real
evidence our extraction is right. The only two nominal differences are naming (`NoOp`/`NOP1`,
`SetMix`/`SetFgMix`). **Line types agree completely too**, including the trap: `LT_DEFAULT = 0` and
`LT_SOLID = 7`.

### BUT ITS SOURCE IS IBM HOST ON-DEMAND, NOT THIS BOOK — which is why it is interesting

`GocaDecoder.java` cites **`HODDecoder`, `HODDrawOrder2Byte`, `HODEllipse`,
`HODSegmentCharacteristics`**, with line references such as `HODDecoder:2229`, and states that orders
"follow IBM GA23-0059 and Host On-Demand (HOD) architecture rules". So it tracks **IBM's own Java
implementation** of the 3270 binding, using GA23-0059 only for the envelope — precisely the layer
GOCA-for-AFP cannot give us. **That makes it a different KIND of evidence from a specification: it is
a second implementation's reading of a binding we do not have.**

### Orders it has that AFP GOCA lacks — the candidate 3270-binding set

| code | j3270's name |
|---|---|
| `X'07'` | Set Marker Color |
| `X'1B'` | Set Marker Size |
| `X'23'` | Set Viewing Window Definition |
| `X'27'` | Set Viewing Window |
| `X'2A'` | Call Segment |
| `X'3F'` | Pop Attribute |
| `X'70'` | Begin Segment |
| `X'7E'` | Erase Graphics Plane |

Several are obviously terminal-oriented rather than printer-oriented — an **Erase Graphics Plane** and
a **Viewing Window** make sense on a display and not on a page — which is consistent with these being
genuinely part of the 3270 binding. Note `X'70'` Begin Segment is a *command* in AFP GOCA (Table 12),
not a drawing order; j3270 puts it in the same dispatch, which may be a namespace difference or may be
how the 3270 binding works. **Unresolved.**

It also defines **procedure orders** for `Object Control X'0F11'` that have no AFP analogue at all:
`P_ATTCUR X'08'` attach graphic cursor, `P_DETCUR X'09'`, `P_ERASE X'0A'`, `P_STOPDR X'0F'`,
`P_BEGPROC X'30'`, `P_SETCUR X'31'`. A **graphics cursor** is a display concept; this is the clearest
sign that the 3270 binding has a whole dimension AFP does not.

### ONE REAL CONFLICT, UNRESOLVED — Partial Arc

| | at CP | absolute |
|---|---|---|
| **AFP GOCA** (Table 16, verified) | `X'A3'` | `X'E3'` |
| **j3270** | `X'86'` | `X'C6'` |

**These cannot both be right for one device, and neither source can settle it from here.** Our values
are transcribed from a table we have read; j3270's are transcribed from HoD, which we have not.
**A THIRD SOURCE NARROWS IT WITHOUT CLOSING IT (2026-09-28):** blueglass lists three-point **Arc** at
`C6`/`86` with a full operand layout and puts Partial Arc at `A3`/`E3`, raising the possibility that
j3270 has named three-point Arc "Partial Arc". A naming collision, not an opcode conflict. **Still
unconfirmed** — see the 2026-09-28 section.
**Do not "fix" either to match the other.** If arcs ever render wrong, this is the first thing to
check. Note j3270's `X'86'`/`X'C6'` do fit the at-CP/absolute bit-1 pairing just as `X'A3'`/`X'E3'`
do, so the pattern does not discriminate between them.

Orders our book has that j3270 omits: `X'04'` Segment Characteristics (it treats `0x04` as a 2-byte
NOP "per HoD"), `X'43'` Set Pick Id, `X'80'`/`X'C0'` **Box**, `X'B2'` Set Process Color. **Box being
absent is worth noting** — it is a primitive one would expect a terminal to want.
**SETTLED 2026-09-28: Box is NOT part of the 3270 binding.** Blueglass reaches the same conclusion
independently and the HOD matrix has no Box row at all — three sources. See the 2026-09-28 section.

### How much to trust it

- **License is not a constraint**: Unlicense, public domain, so reading or borrowing is unrestricted.
- **It is a second reading, not a second specification.** Where it agrees with our book, confidence
  rises sharply. Where it differs, we have two transcriptions and no arbiter.
- **It claims no live-host verification of graphics.** The README's "tested and verified against" list
  is JDK distributions (Temurin, Semeru), not hosts or terminals. So it is **not** the live witness
  this feature lacks — it is another paper implementation, albeit a much more specific one.
- **Its structured-field constants are organised differently** (`SF_OBJCNTL = 0x24`, `SF_OBJDATA =
  0x85`, `SF_3270_G = 0x20`, alongside sub-IDs `0x0F`/`0x10`/`0x11` under SF `0x0F`). **Our
  `0x0F0F`/`0x0F10`/`0x0F11` come straight from GA23-0059-07 and are not in doubt**; understanding
  its numbering is a task for whoever implements, not a correction to ours.

**Practical upshot: consult `GocaDecoder.java` while implementing, as a behavioural reference for the
3270 binding, exactly as VMGIF is treated for PS.** It is the best available substitute for
GA18-2177/GA18-2535 until those are found — but it is a substitute, and its Partial Arc conflict is a
live reminder that it is not authoritative.

## A THIRD AND FOURTH READING: THE HOD SUPPORT MATRIX AND A 3192G ROM DISASSEMBLY (2026-09-28)

The user supplied two more sources. **One of them is a different KIND of evidence from everything
above: a disassembly of the 3192G's own firmware.** Where this file has had specifications and one
other implementation's reading of a specification, that is the device itself.

| Source | What it is | Standing |
|---|---|---|
| <https://scc.its.state.nc.us/hod/en/help/nativegraph.html> | IBM Host On-Demand's own order-support matrix, 5 emulator columns x 50 rows. **Fetched and parsed in full, not summarised** | Documents what *emulators* accept, including a `HOD V4.0/3192-G` column |
| `$HOME/blueglass — 3270 Graphics & SNA Research Findings.md` | @MK, 2026-09-25. GDDM Base + GA23-0059 + ZZ20-4167 + **a 3192G ROM disassembly**, every claim provenance-marked | The firmware claims are the strongest evidence this project has for graphics |

**Read blueglass's own provenance markers before relying on a line of it.** It distinguishes
`[2+ sources]`, `[single source]`, `[ROM]`, `[inferred]`, `[to verify]` and `[rejected]` — that
discipline is why it can be trusted where it is confident, and it is explicit that `[ROM]` means
"what the firmware does, not necessarily what IBM specified".

### HOD's matrix and the ROM DISAGREE, and the disagreement is the useful part

HOD leaves **Arc (C6/86) blank** for the 3192-G, and blueglass reports the firmware has **a real
Arc handler** (ROM dispatch table). Both can be true: **HOD's matrix documents HOD's limits, not the
terminal's.** The same pattern explains the matrix's asterisked rows — `Set Character Angle (34)` and
`Set Character Shear (35)` are ticked for HOD with the footnote *"Host On-Demand Version 4.0 accepts
these graphics orders, but ignores them"*, while the firmware **honours both** (34 scaling x by 3 and
y by 4, which looks like aspect correction).

**So a support matrix is a statement about a client. Do not read it as a device capability**, in
either direction — and note this cuts against our own earlier note, which recorded Arc's blank cell
as "possibly an HOD limitation `[to verify]`". It was.

Two cells worth recording because a prose summary of this page got them wrong: **`Set Viewing
Window (27)` is J3270PC-only** (blank for the 3192-G), and **`Segment Characteristics (04)` and
`End of Symbol Definition (FF)` are 3192-G-only.**

### What the ROM settles that this file listed as open

| Question | Answer | Marker |
|---|---|---|
| Coordinate origin | Centre at pel (360,191), one unit per pel, Y **up**; screen is -360..359 x -192..191. Only the **graphics cursor** scales y by 3/4 | Price + firmware |
| Arc (C6/86) supported? | **Yes**, real handler, HOD's blank cell notwithstanding | ROM |
| Character Angle / Shear honoured? | **Yes**, both; HOD merely accepts and ignores them | ROM |
| Procedural instruction layouts (08, 09, 0A, 0F, 31) | 08/09/0A/0F are fixed 2-byte with operand 00; 31 is long. **All go in `0F11` Object Control**, not `0F10` | ROM |
| Query reply payloads B2, B4, B6 | B2 = line types 1-8 (**default 7**), B4 = colours 0-7 as red/blue/green plane flags, B6 = built-in F0 sets | ROM, 3192G only |
| Segment FLAG1/FLAG2 reserved bits | Never read. Copying Price's `74`/`68` is safe. **Bit 0 of FLAG2 (nonchained) is REJECTED with error 43 — send chained segments only** | ROM |

### Image encoding rules, which are firmware-exact and will bite an encoder

Worth transcribing because these are error codes, not preferences:

- **No scaling.** `Begin Image` must be exactly `D1 0A` or `91 06`; GDF's optional
  IMAGEWIDTH/IMAGEDEPTH are **rejected with error 68**. FORMAT must be 0.
- **Rows.** Each `Image Data` length must be exactly `ceil(WIDTH/8)` (**error 73**); more rows than
  DEPTH is **error 75**; fewer is accepted. `End Image` is `93 02 0000`.
- **CLIPPING IS PER ROW, and this is the trap:** a row off-screen vertically, or sticking out past
  either side edge, is **skipped whole**. An image wider than the screen therefore **draws nothing**.
  **Our encoder must clip host-side** — the terminal will not do it for us, and the failure mode is a
  blank screen rather than a truncated picture.
- **Colour is per plane.** Each image draws in the current colour and mix, so a full-colour picture
  is one image per plane, composed with OR or XOR (colour indices are bit-coded: blue 1, red 2,
  green 4). No native IOCA on this family.
- Still untested on hardware: **bit order within a byte** (GDF says leftmost pel = high bit) and
  **whether 0 bits are transparent** (`[inferred]` yes, since Set Background Mix is ignored).

### It does NOT settle Partial Arc — but it reframes the conflict

Blueglass puts **Partial Arc at `A3`/`E3`** in its "AFP-era additions, absent from GDDM and HOD"
bucket, and *separately* lists **three-point Arc at `C6`/`86`** with a full operand layout. j3270
calls `86`/`C6` **Partial Arc**.

**A HYPOTHESIS THIS FILE DID NOT HAVE: j3270 may be labelling three-point Arc as Partial Arc.** That
would make both transcriptions right about the bytes and wrong only about the name, which is a much
cheaper problem than two devices disagreeing about an opcode. **Not confirmed — do not act on it**,
and the standing instruction stands: do not "fix" either source to match the other. But if arcs
render wrong, check the *name* before the *byte*.

### Box: a second source now says it is not a 3270 order

Blueglass puts **`Box` (80/C0)** in the same absent-from-GDDM-and-HOD bucket, independently of
j3270's omission of it. **Two sources, arrived at separately, now agree Box is not part of this
binding** — and the HOD matrix has no Box row at all, which is a third.

This matters beyond the order itself: `docs/ideas/composite-model-idea.md` uses Box as its worked
example of a capability whose status is "unresolved on a faithful model". **It is no longer
unresolved.** The idea survives — a composite model can support an order no real terminal did, which
is rather the point — but the premise should be restated as "Box is absent from the 3270 binding,
and this model adds it" rather than "Box's status is unknown".

### Non-graphics findings worth keeping

- **Errors are coarse.** A rejected order returns a negative response with sense **1003** (function
  not supported) or **1005** (parameter error). **The host learns the class of error, not which
  order failed** — so a generator cannot be debugged by sense code alone.
- **Throughput** `[single source: ZZ20-4167, channel-attached 3174-11]`: SNA RU 2048/N=2 = 73.4 KB/s;
  the `(2N-1) x RU` product must fit the ~7.5 KB usable device buffer. A full-screen three-plane
  bitmap is ~105 KB, so ~1.4 s to transmit: **fine for stills, not for animation.**
- **DBUF is 8 KB and the 3179G runs the same code as the 3192G**, so ROM findings apply to both.

### The gap this leaves

**Blueglass cites a `GRAPHICS_DATA_STREAM.md` for the ROM addresses (`1A:571B`, `1A:0906-097C`,
the `0F11` dispatcher at `1A:1297`) and THAT FILE IS NOT ON THIS BOX.** The findings are recorded
here; the underlying disassembly evidence is not. **Ask the user for it before designing the order
generator** — it is the difference between "the firmware honours Arc" and knowing what its handler
actually accepts.

Still no live witness and still no x3270 oracle. Blueglass does not change that; a ROM disassembly
tells us what the device would do, not that we have made it do anything.

## Still missing after all four sources

1. **The 3179-G / 3192-G manuals — NOW IDENTIFIED BY ORDER NUMBER: `GA18-2177` and `GA18-2535`**
   (see the section above). Which subset the terminal accepts, its defaults, and its pel geometry.
   GOCA gives primitives; it does not say what a G-terminal does with them, and GA23-0059-07 defers
   to these seven times over. **PARTLY ANSWERED 2026-09-28 by the 3192G ROM disassembly**, which
   supplies the accepted subset, several defaults and the pel geometry for the 3192G (and so for the
   3179G, same code). The manuals are still wanted for what IBM *specified* as against what this
   firmware *does*, but they are no longer the only route to the device facts.
   **A NEARER ASK: `GRAPHICS_DATA_STREAM.md`, blueglass's own companion file holding the ROM
   addresses. It is not on this box.**
2. **The 3270 binding of GOCA** — the equivalent of Appendix A/B for the 3270 data stream. Unknown
   whether a separate publication exists.
3. ~~**Pel dimensions for the G-terminals.**~~ **ANSWERED 2026-09-28: 720 x 384 pels** `[hardware]`,
   cell 9x12 or 9x16 by page depth `[single source: GDDM]`, origin at centre pel (360,191) with Y up
   `[Price + firmware]`. **The three parts have three different provenances — quote them separately;
   only the origin is ROM-confirmed.** Runtime discovery via **Usable
   Area** and **Implicit Partition** Query Replies (both of which we already build and send) remains
   the right mechanism — prycroft6's point stands — but the constants are now known, which means a
   generator can be written and tested before any device answers a query.
4. **Any reference implementation.** Neither x3270 nor c3270 has a `0x0F0F`/`0x0F10`/`0x0F11` arm.
   No Hercules host here drives a G-terminal. **This remains the first feature with neither an
   x3270 oracle nor a live witness**, and none of the four sources changes that: j3270 is another
   paper implementation, the HOD matrix documents clients, and a ROM disassembly says what the
   device would do rather than what we have made it do. **Unchanged after everything —
   this is still the hardest fact about this feature.**

## Tooling

No `poppler` on this box (`pdftotext`, `pdftoppm`, `pdfinfo` all absent, including under the LSST
stack — so the Read tool cannot render this PDF). `pip install --user pypdf` works, has network
access, and is pure Python with no system dependency. Extraction:

```python
import pypdf
r = pypdf.PdfReader('$HOME/S544-5498-01_GOCA_for_AFP_Reference_Oct2000.pdf')
text = [(i, p.extract_text() or '') for i, p in enumerate(r.pages)]
```

Text quality is good but the PDF is a 1997–2000 SCRIPT/VS document distilled on AIX: **bullet
glyphs come out as `Ðb╦╗╗e╩╝ed` mojibake and `X'nn'` renders as `X }nn}`** — grep for `X }` rather
than `X'`, or a search for order codes silently finds nothing.
