# The `bracket` default code page, and `-codepage` — design

2026-11-24. README *Staging* 15a's last item; parity row `code-page`. Approved by the user
2026-11-24 (scope option B: change the default AND add the flag, two pages only).

## The problem

x3270 defaults to the `bracket` code page (`Common/codepage.c:358`, `get_codepage_name`); we
have only cp037 and default to it. At the defaults the two clients put `[` and `]` at different
bytes, so a `[` typed into our client is not the byte an x3270 user's `[` is.

## What `bracket` is

Diffing the two tables in `Common/unicode.c` (cp037 at :103, bracket at :293; both tables start
at byte 0x41), `bracket` is cp037 with exactly four bytes changed:

| byte | cp037 | bracket |
|------|-------|---------|
| 0xAD | Ý     | `[`     |
| 0xBA | `[`   | Ý       |
| 0xBB | `]`   | ¨       |
| 0xBD | ¨     | `]`     |

Same character set, different byte positions. Both declare CGCSGID 37 (`"37", "37"` in the
table entries).

## Design

### 1. Core

- **`packages/core/src/codepages/bracket.ts`:** the 256-entry table, copied from
  `unicode.c:293`, not derived from cp037 in code. A test holds x3270's two table entries
  pasted verbatim (citing `unicode.c:103` and `:293`, suite3270 4.5), asserts our tables equal
  them, and asserts they differ in exactly the four bytes above.
- **`CodePage` gains `cgcsgid: number`** (constructor argument). cp037 and bracket both use 37.
- **TN3270E `CODEPAGE` (`session.ts`, the NEW-ENVIRON builder near :830)** is formatted from
  `cgcsgid & 0xffff`, `%03d` under 100 else `%d`, as `telnet_new_environ.c:255-260` does. It is
  no longer derived from the page's name, which would send `bracket`. Both pages send `037`.
- **`DEFAULT_CODE_PAGE = bracket`**, exported from `codepage.ts`, replaces the four separate
  `?? cp037` fallbacks: `screen.ts:172`, `render.ts:339`, `keyboard.ts:33`, `session.ts:507`
  (and the `:829` name fallback, which goes away with the item above).
- **Deliberately unchanged:** `bind.ts` (LU name text), `ft/frames.ts` (transfer status text)
  and `ft/cut.ts` (its own `ebc2asc0` tables). Their comments already explain why they don't
  use the session page. The `IND$FILE` typing in `frontend/src/transfer.ts` uses bytes
  (`$` = 0x5B) that are the same on both pages; its test stays as-is.
- **`resolveCodePage(name)`** in `codepage.ts` replaces `getCodePage`. It ignores case and
  accepts the canonical names plus x3270's aliases for these two pages (`unicode.c:381-422`):
  - cp037: `cp037`, `cp37`, `037`, `37`, `us`, `us-intl`
  - bracket: `bracket`, `oldibm`, `bracket437`

  An unknown name throws an error that names the valid choices. `CODE_PAGES` holds both pages.

### 2. Front ends

- `-codepage <name>`, with `-charset` as an alias (x3270 `x3270.c:156`, `:159`), in the GUI,
  the TUI, the web gateway and the CLI. Each resolves it with `resolveCodePage` at startup and
  passes the result through `Session`'s existing `codePage` option.
- **An unknown name is a startup error:** the message puts the remedy first, e.g. `-codepage: use one of bracket, cp037 (got
  'cp273')`, and the client exits non-zero. Falling back silently would hide a typo that
  changes what `[` and `]` send.
- The web gateway's setting applies to the whole server; every browser session uses it.
- `--help` text and the README's flag tables list the flag.

### 3. Canvas

**No change to the drawing path.** `drawlist.ts:164` maps each screen character through
`cp037.fromUnicode` and then `ebcdicToCg`. That byte is only an intermediate for the glyph
lookup, so any character in cp037's set gets its correct glyph whichever page decoded it, and
`bracket` has the same set. The cp037-fixed `cg.ts` path only matters for pages with
characters cp037 lacks, which is 15c. The parity row's `cg.ts` remark moves to 15c's
README text.

This is a claim from reading the code, so a test must show it: a screen whose bytes 0xAD,
0xBA, 0xBB and 0xBD were decoded under `bracket` draws the CG glyphs for `[`, Ý, ¨ and `]`.

## Testing

- **Unit:** the table check against x3270; the four-byte diff; alias resolution (every alias,
  mixed case); the unknown-name error text; `CODEPAGE` = `037` for both pages; at the default,
  typed `[` `]` encode as 0xAD 0xBD and inbound 0xAD 0xBD decode as `[` `]`; with cp037, 0xBA
  0xBB both ways; the canvas test above; each front end's flag parsing, including `-charset`
  and the unknown-name exit.
- **Mutation (manual, small):** revert each of the four default sites to cp037 in turn, and
  drop an alias. Each change must fail a test.
- **Live witness, VM/370:** type `[ ]` into a CMS file with each page, then fetch the file
  with a **binary** `IND$FILE` receive (no translation) and hexdump it locally. Expect
  `AD BD` at the default and `BA BB` with `-codepage cp037`. The bytes come from the host, so
  the proof doesn't rest on our own tables. Record it in `docs/live-testing.md`.
- **Parity:** the `code-page` row becomes `ours` with the witness, and the gate's blocking
  count drops by one.

## Out of scope (15c, 15b)

Other code pages; a page per connection in the web gateway; the GUI's Options → Code Page menu
(15b); `sbcsCgcsgid`; DBCS.
