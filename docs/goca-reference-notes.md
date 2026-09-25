# GOCA drawing orders — extracted reference notes

**Purpose.** `docs/HANDOFF.md` records that the 3270 Programmer's Reference defines the *envelope*
for native vector graphics (`Object Control X'0F11'`, `Object Data X'0F0F'`, `Object Picture
X'0F10'`) and then defers byte 7–n to "the appropriate graphics or image publications". This file
records what those publications say, so the next session does not re-derive it.

**Source.** `$HOME/S544-5498-01_GOCA_for_AFP_Reference_Oct2000.pdf` — *Graphics Object Content
Architecture for Advanced Function Presentation Reference*, S544-5498-01, October 2000, 216 pages.
Supplied by the user 2026-09-25. Text extracts cleanly with `pypdf` (see *Tooling* below).

**STATUS: this is a paper exercise. Nothing here has been checked against a terminal, an emulator,
or a byte on a wire.** Read the caveat section before designing against it.

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

## Still missing after this book

1. **The 3179-G / 3192-G manuals — NOW IDENTIFIED BY ORDER NUMBER: `GA18-2177` and `GA18-2535`**
   (see the section above). Which subset the terminal accepts, its defaults, and its pel geometry.
   GOCA gives primitives; it does not say what a G-terminal does with them, and GA23-0059-07 defers
   to these seven times over.
2. **The 3270 binding of GOCA** — the equivalent of Appendix A/B for the 3270 data stream. Unknown
   whether a separate publication exists.
3. **Pel dimensions for the G-terminals.** Still unrecorded anywhere we have. prycroft6 says an
   application discovers the drawing space from **Usable Area** and **Implicit Partition** Query
   Replies, both of which we already build and send — so this may be discoverable at runtime rather
   than needing a constant.
4. **Any reference implementation.** Neither x3270 nor c3270 has a `0x0F0F`/`0x0F10`/`0x0F11` arm.
   No Hercules host here drives a G-terminal. **This remains the first feature with neither an
   x3270 oracle nor a live witness**, and this book does not change that — it is a specification,
   not an oracle.

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
